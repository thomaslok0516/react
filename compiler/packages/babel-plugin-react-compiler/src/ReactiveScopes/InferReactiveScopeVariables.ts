/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { CompilerError, SourceLocation } from "..";
import { Environment } from "../HIR";
import {
  GeneratedSource,
  HIRFunction,
  Identifier,
  Instruction,
  Place,
  ReactiveScope,
  makeInstructionId,
} from "../HIR/HIR";
import {
  doesPatternContainSpreadElement,
  eachInstructionOperand,
  eachPatternOperand,
} from "../HIR/visitors";
import DisjointSet from "../Utils/DisjointSet";
import { logHIRFunction } from "../Utils/logger";
import { assertExhaustive } from "../Utils/utils";

/*
 * Note: this is the 1st of 4 passes that determine how to break a function into discrete
 * reactive scopes (independently memoizeable units of code):
 * 1. InferReactiveScopeVariables (this pass, on HIR) determines operands that mutate
 *     together and assigns them a unique reactive scope.
 * 2. AlignReactiveScopesToBlockScopes (on ReactiveFunction) aligns reactive scopes
 *     to block scopes.
 * 3. MergeOverlappingReactiveScopes (on ReactiveFunction) ensures that reactive
 *     scopes do not overlap, merging any such scopes.
 * 4. BuildReactiveBlocks (on ReactiveFunction) groups the statements for each scope into
 *     a ReactiveScopeBlock.
 *
 * For each mutable variable, infers a reactive scope which will construct that
 * variable. Variables that co-mutate are assigned to the same reactive scope.
 * This pass does *not* infer the set of instructions necessary to compute each
 * variable/scope, only the set of variables that will be computed by each scope.
 *
 * Examples:
 * ```javascript
 * // Mutable arguments
 * let x = {};
 * let y = [];
 * foo(x, y); // both args mutable, could alias each other
 * y.push(x); // y is part of callee, counts as operand
 *
 * let z = {};
 * y.push(z);
 *
 * // Mutable assignment
 * let x = {};
 * let y = [];
 * x.y = y; // trivial aliasing
 * ```
 *
 * More generally, all mutable operands (incl lvalue) of an instruction must go in the
 * same scope.
 *
 * ## Implementation
 *
 * 1. Iterate over all instructions in all blocks (order does not matter, single pass),
 *     and create disjoint sets ({@link DisjointSet}) for each set of operands that
 *     mutate together per above rules.
 * 2. Iterate the contents of each set, and assign a new {@link ScopeId} to each set,
 *     and update the `scope` property of each item in that set to that scope id.
 *
 * ## Other Issues Uncovered
 *
 * Mutable lifetimes need to account for aliasing (known todo, already described in InferMutableLifetimes.ts)
 *
 * ```javascript
 * let x = {};
 * let y = [];
 * x.y = y; // RHS is not considered mutable here bc not further mutation
 * mutate(x); // bc y is aliased here, it should still be considered mutable above
 * ```
 */
export function inferReactiveScopeVariables(fn: HIRFunction): void {
  /*
   * Represents the set of reactive scopes as disjoint sets of identifiers
   * that mutate together.
   */
  const scopeIdentifiers = findDisjointMutableValues(fn);

  // Maps each scope (by its identifying member) to a ScopeId value
  const scopes: Map<Identifier, ReactiveScope> = new Map();

  /*
   * Iterate over all the identifiers and assign a unique ScopeId
   * for each scope (based on the set identifier).
   *
   * At the same time, group the identifiers in each scope and
   * build a MutableRange that describes the span of mutations
   * across all identifiers in each scope.
   */
  scopeIdentifiers.forEach((identifier, groupIdentifier) => {
    let scope = scopes.get(groupIdentifier);
    if (scope === undefined) {
      scope = {
        id: fn.env.nextScopeId,
        range: identifier.mutableRange,
        dependencies: new Set(),
        declarations: new Map(),
        reassignments: new Set(),
        earlyReturnValue: null,
        merged: new Set(),
        loc: identifier.loc,
      };
      scopes.set(groupIdentifier, scope);
    } else {
      if (scope.range.start === 0) {
        scope.range.start = identifier.mutableRange.start;
      } else if (identifier.mutableRange.start !== 0) {
        scope.range.start = makeInstructionId(
          Math.min(scope.range.start, identifier.mutableRange.start)
        );
      }
      scope.range.end = makeInstructionId(
        Math.max(scope.range.end, identifier.mutableRange.end)
      );
      scope.loc = mergeLocation(scope.loc, identifier.loc);
    }
    identifier.scope = scope;
    identifier.mutableRange = scope.range;
  });

  let maxInstruction = 0;
  for (const [, block] of fn.body.blocks) {
    for (const instr of block.instructions) {
      maxInstruction = makeInstructionId(Math.max(maxInstruction, instr.id));
    }
    maxInstruction = makeInstructionId(
      Math.max(maxInstruction, block.terminal.id)
    );
  }

  /*
   * Validate that all scopes have properly intialized, valid mutable ranges
   * within the span of instructions for this function, ie from 1 to 1 past
   * the last instruction id.
   */
  for (const [, scope] of scopes) {
    if (
      scope.range.start === 0 ||
      scope.range.end === 0 ||
      maxInstruction === 0 ||
      scope.range.end > maxInstruction + 1
    ) {
      // Make it easier to debug why the error occurred
      logHIRFunction("InferReactiveScopeVariables (invalid scope)", fn);
      CompilerError.invariant(false, {
        reason: `Invalid mutable range for scope`,
        loc: GeneratedSource,
        description: `Scope @${scope.id} has range [${scope.range.start}:${
          scope.range.end
        }] but the valid range is [1:${maxInstruction + 1}]`,
      });
    }
  }
}

function mergeLocation(l: SourceLocation, r: SourceLocation): SourceLocation {
  if (l === GeneratedSource) {
    return r;
  } else if (r === GeneratedSource) {
    return l;
  } else {
    return {
      start: {
        line: Math.min(l.start.line, r.start.line),
        column: Math.min(l.start.column, r.start.column),
      },
      end: {
        line: Math.max(l.end.line, r.end.line),
        column: Math.max(l.end.column, r.end.column),
      },
    };
  }
}

// Is the operand mutable at this given instruction
export function isMutableAtInstruction(
  { id }: Instruction,
  place: Place
): boolean {
  const range = place.identifier.mutableRange;
  return id >= range.start && id < range.end;
}

function mayAllocate(env: Environment, instruction: Instruction): boolean {
  const { value } = instruction;
  switch (value.kind) {
    case "Destructure": {
      return doesPatternContainSpreadElement(value.lvalue.pattern);
    }
    case "PostfixUpdate":
    case "PrefixUpdate":
    case "Await":
    case "DeclareLocal":
    case "DeclareContext":
    case "StoreLocal":
    case "LoadGlobal":
    case "MetaProperty":
    case "TypeCastExpression":
    case "LoadLocal":
    case "LoadContext":
    case "StoreContext":
    case "PropertyDelete":
    case "ComputedLoad":
    case "ComputedDelete":
    case "JSXText":
    case "TemplateLiteral":
    case "Primitive":
    case "GetIterator":
    case "IteratorNext":
    case "NextPropertyOf":
    case "Debugger":
    case "StartMemoize":
    case "FinishMemoize":
    case "UnaryExpression":
    case "BinaryExpression":
    case "PropertyLoad":
    case "StoreGlobal": {
      return false;
    }
    case "CallExpression":
    case "MethodCall": {
      return instruction.lvalue.identifier.type.kind !== "Primitive";
    }
    case "RegExpLiteral":
    case "PropertyStore":
    case "ComputedStore":
    case "ArrayExpression":
    case "JsxExpression":
    case "JsxFragment":
    case "NewExpression":
    case "ObjectExpression":
    case "UnsupportedNode":
    case "ObjectMethod":
    case "FunctionExpression":
    case "TaggedTemplateExpression": {
      return true;
    }
    default: {
      assertExhaustive(
        value,
        `Unexpected value kind \`${(value as any).kind}\``
      );
    }
  }
}

/*
 * These instructions may pick up external changes due to rules of react violations.
 * Instructions should be included here if they may change without their inputs changing.
 * For example, PostfixUpdate is not included because it only has a changed lval if
 * it has a changed argument, but LoadProperty is included because the argument can be
 * mutated elsewhere.
 */
function mayHaveChanged(env: Environment, instruction: Instruction): boolean {
  if (env.config.enableChangeDetectionForDebugging == null) {
    return false;
  }
  switch (instruction.value.kind) {
    case "Await":
    case "ComputedLoad":
    case "Destructure":
    case "GetIterator":
    case "IteratorNext":
    case "NextPropertyOf":
    case "PropertyLoad":
    case "CallExpression":
    case "MethodCall":
    case "NewExpression": {
      return true;
    }
    case "LoadGlobal": {
      return (
        instruction.value.binding.kind === "ModuleLocal" &&
        !instruction.value.binding.immutable
      );
    }
    case "PostfixUpdate":
    case "PrefixUpdate":
    case "DeclareLocal":
    case "DeclareContext":
    case "StoreLocal":
    case "MetaProperty":
    case "TypeCastExpression":
    case "LoadLocal":
    case "LoadContext":
    case "StoreContext":
    case "PropertyDelete":
    case "ComputedDelete":
    case "JSXText":
    case "TemplateLiteral":
    case "Primitive":
    case "Debugger":
    case "StartMemoize":
    case "FinishMemoize":
    case "UnaryExpression":
    case "BinaryExpression":
    case "StoreGlobal":
    case "RegExpLiteral":
    case "PropertyStore":
    case "ComputedStore":
    case "ArrayExpression":
    case "JsxExpression":
    case "JsxFragment":
    case "ObjectExpression":
    case "UnsupportedNode":
    case "ObjectMethod":
    case "FunctionExpression":
    case "TaggedTemplateExpression": {
      return false;
    }
    default: {
      assertExhaustive(
        instruction.value,
        `Unexpected value kind \`${(instruction.value as any).kind}\``
      );
    }
  }
}

function isIdentifierMutable(id: Identifier): boolean {
  return id.mutableRange.end > id.mutableRange.start + 1;
}

function identifierHasMutableRange(id: Identifier): boolean {
  return id.mutableRange.start > 0;
}

export function findDisjointMutableValues(
  fn: HIRFunction
): DisjointSet<Identifier> {
  const scopeIdentifiers = new DisjointSet<Identifier>();
  for (const [_, block] of fn.body.blocks) {
    /*
     * If a phi is mutated after creation, then we need to alias all of its operands such that they
     * are assigned to the same scope.
     */
    for (const phi of block.phis) {
      if (
        // The phi was reset because it was not mutated after creation
        isIdentifierMutable(phi.id) &&
        phi.id.mutableRange.end >
          (block.instructions.at(0)?.id ?? block.terminal.id)
      ) {
        for (const [, phiId] of phi.operands) {
          scopeIdentifiers.union([phi.id, phiId]);
        }
      } else if (fn.env.config.enableForest) {
        for (const [, phiId] of phi.operands) {
          scopeIdentifiers.union([phi.id, phiId]);
        }
      }
    }

    for (const instr of block.instructions) {
      const operands: Array<Identifier> = [];
      if (
        isIdentifierMutable(instr.lvalue.identifier) ||
        mayAllocate(fn.env, instr) ||
        mayHaveChanged(fn.env, instr)
      ) {
        operands.push(instr.lvalue!.identifier);
      }
      if (
        instr.value.kind === "StoreLocal" ||
        instr.value.kind === "StoreContext"
      ) {
        if (isIdentifierMutable(instr.value.lvalue.place.identifier)) {
          operands.push(instr.value.lvalue.place.identifier);
        }
        if (
          isMutableAtInstruction(instr, instr.value.value) &&
          identifierHasMutableRange(instr.value.value.identifier)
        ) {
          operands.push(instr.value.value.identifier);
        }
      } else if (instr.value.kind === "Destructure") {
        for (const place of eachPatternOperand(instr.value.lvalue.pattern)) {
          if (
            isIdentifierMutable(place.identifier) ||
            mayHaveChanged(fn.env, instr)
          ) {
            operands.push(place.identifier);
          }
        }
        if (
          (isMutableAtInstruction(instr, instr.value.value) &&
            identifierHasMutableRange(instr.value.value.identifier)) ||
          mayHaveChanged(fn.env, instr)
        ) {
          operands.push(instr.value.value.identifier);
        }
      } else if (instr.value.kind === "MethodCall") {
        for (const operand of eachInstructionOperand(instr)) {
          if (
            (isMutableAtInstruction(instr, operand) &&
              /*
               * exclude global variables from being added to scopes, we can't recreate them!
               * TODO: improve handling of module-scoped variables and globals
               */
              identifierHasMutableRange(operand.identifier)) ||
            mayHaveChanged(fn.env, instr)
          ) {
            operands.push(operand.identifier);
          }
        }
        /*
         * Ensure that the ComputedLoad to resolve the method is in the same scope as the
         * call itself
         */
        operands.push(instr.value.property.identifier);
      } else {
        for (const operand of eachInstructionOperand(instr)) {
          if (
            (isMutableAtInstruction(instr, operand) &&
              /*
               * exclude global variables from being added to scopes, we can't recreate them!
               * TODO: improve handling of module-scoped variables and globals
               */
              identifierHasMutableRange(operand.identifier)) ||
            mayHaveChanged(fn.env, instr)
          ) {
            operands.push(operand.identifier);
          }
        }
      }
      if (operands.length !== 0) {
        scopeIdentifiers.union(operands);
      }
    }
  }
  return scopeIdentifiers;
}
