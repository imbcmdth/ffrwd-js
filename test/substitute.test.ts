/**
 * Substitution parity: every case in `fixtures/substitute.json` was produced by
 * the CLI's own `ffrwd/vars.py`, and the port has to match it byte for byte --
 * refusals compared by the sentence they carry.
 */

import { describe, expect, it } from "vitest";
import { FfrwdError, declaredVariables, referenced, substitute } from "../src/index.js";
import fixture from "./fixtures/substitute.json" with { type: "json" };

interface SubstituteCase {
  name: string;
  text: string;
  variables: Record<string, string>;
  text_out?: string;
  unset?: Record<string, string>;
  refusal?: { message: string; hint: string; line: number | null; col: number | null };
}

interface ReferencedCase {
  name: string;
  text: string;
  names: string[];
}

interface DeclaredCase {
  name: string;
  text: string;
  variables: Array<{ name: string; description: string }>;
}

const cases = fixture as unknown as {
  substitute: SubstituteCase[];
  referenced: ReferencedCase[];
  declared: DeclaredCase[];
};

describe("substitute, against the Python implementation", () => {
  it("covers every form the fixture was generated over", () => {
    expect(cases.substitute.length).toBeGreaterThanOrEqual(15);
    expect(cases.substitute.filter((one) => one.refusal !== undefined).length).toBe(6);
  });

  for (const one of cases.substitute) {
    it(one.name, () => {
      if (one.refusal !== undefined) {
        try {
          substitute(one.text, one.variables);
          throw new Error(`expected a refusal for ${one.name}`);
        } catch (err) {
          expect(err).toBeInstanceOf(FfrwdError);
          const refusal = err as FfrwdError;
          expect(refusal.error).toBe(one.refusal.message);
          expect(refusal.message).toBe(one.refusal.message);
          expect(refusal.hint).toBe(one.refusal.hint);
          expect(refusal.status).toBe(0);
        }
        return;
      }
      const got = substitute(one.text, one.variables);
      expect(got.text).toBe(one.text_out);
      expect(Object.fromEntries(got.unset)).toEqual(one.unset);
    });
  }
});

describe("referenced, against the Python implementation", () => {
  for (const one of cases.referenced) {
    it(one.name, () => {
      expect([...referenced(one.text)].sort()).toEqual(one.names);
    });
  }
});

describe("declaredVariables, against the Python implementation", () => {
  for (const one of cases.declared) {
    it(one.name, () => {
      expect(declaredVariables(one.text)).toEqual(one.variables);
    });
  }
});
