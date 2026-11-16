/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  type FormField,
  formToSchema,
  moveField,
  moveSubField,
  type SchemaForm,
  schemasEqual,
  schemaToForm,
} from "./schema-form";

/** A leaf-typed field for test fixtures. */
function leaf(name: string, required = false): FormField {
  return { name, type: "string", description: "", required, children: [], requiredOrder: [] };
}

/** A group field with named sub-fields, some required. */
function group(
  name: string,
  children: Array<[name: string, required: boolean]>,
  required = false,
): FormField {
  return {
    name,
    type: "object",
    description: "",
    required,
    children: children.map(([childName, childRequired]) => ({
      name: childName,
      type: "string",
      description: "",
      required: childRequired,
    })),
    requiredOrder: children.filter(([, childRequired]) => childRequired).map(([n]) => n),
  };
}

describe("moveField", () => {
  it("reorders fields and keeps required flags", () => {
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [leaf("a"), leaf("b", true), leaf("c")],
      requiredOrder: ["b"],
    };
    const moved = moveField(form, 2, 0);
    expect(moved.fields.map((field) => field.name)).toEqual(["c", "a", "b"]);
    expect(moved.fields[2]?.required).toBe(true);
  });

  it("rebuilds properties and required in the new visual order", () => {
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [leaf("a", true), leaf("b"), leaf("c", true)],
      requiredOrder: ["a", "c"],
    };
    const schema = formToSchema(moveField(form, 2, 0));
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(["c", "a", "b"]);
    expect(schema.required).toEqual(["c", "a"]);
  });

  it("re-lands a remembered (toggled-off) field at its moved position", () => {
    // b: required; a: was required in the schema, toggled off in the form
    // (requiredOrder still remembers it).
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [leaf("b", true), leaf("a")],
      requiredOrder: ["a"],
    };
    const moved = moveField(form, 1, 0); // a to the top: [a, b]
    expect(moved.requiredOrder).toEqual(["a", "b"]);
    // Toggle a back on: its entry lands at the new visual position, not
    // appended after every always-required name.
    const toggled = {
      ...moved,
      fields: moved.fields.map((field) => (field.name === "a" ? leaf("a", true) : field)),
    };
    const schema = formToSchema(toggled);
    expect(schema.required).toEqual(["a", "b"]);
  });

  it("survives moving a blank in-progress row (form keeps it, schema skips it)", () => {
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [leaf("a"), leaf("")],
      requiredOrder: [],
    };
    const moved = moveField(form, 1, 0);
    expect(moved.fields.map((field) => field.name)).toEqual(["", "a"]);
    const schema = formToSchema(moved);
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(["a"]);
    expect(schemaToForm(schema) !== null).toBe(true);
  });

  it("is a no-op for out-of-bounds or identity moves", () => {
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [leaf("a"), leaf("b")],
      requiredOrder: [],
    };
    expect(moveField(form, 0, 0)).toBe(form);
    expect(moveField(form, -1, 0)).toBe(form);
    expect(moveField(form, 0, 5)).toBe(form);
    expect(moveField(form, 5, 0)).toBe(form);
  });

  it("round-trips exactly after a move", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        g: {
          type: "object",
          properties: { x: { type: "string" }, y: { type: "number" } },
          required: ["x", "y"],
        },
        b: { type: "string" },
      },
      required: ["g", "a"],
    };
    const form = schemaToForm(schema);
    expect(form).not.toBeNull();
    const moved = moveField(form as SchemaForm, 2, 0); // b to the top
    const rebuilt = formToSchema(moved);
    expect(Object.keys(rebuilt.properties as Record<string, unknown>)).toEqual(["b", "a", "g"]);
    expect(rebuilt.required).toEqual(["a", "g"]); // required follows the new visual order
    // And the rebuilt schema parses back to a form producing the same schema.
    const reparsed = schemaToForm(rebuilt);
    expect(reparsed).not.toBeNull();
    expect(schemasEqual(formToSchema(reparsed as SchemaForm), rebuilt)).toBe(true);
  });
});

describe("moveSubField", () => {
  it("reorders children within the group and follows with required", () => {
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [
        group("g", [
          ["x", true],
          ["y", false],
          ["z", true],
        ]),
      ],
      requiredOrder: [],
    };
    const moved = moveSubField(form, 0, 2, 0);
    const field = moved.fields[0];
    expect(field?.children.map((child) => child.name)).toEqual(["z", "x", "y"]);
    expect(field?.requiredOrder).toEqual(["z", "x"]);
    const schema = formToSchema(moved);
    const groupNode = (schema.properties as Record<string, Record<string, unknown>>).g;
    expect(groupNode).toBeDefined();
    expect(Object.keys(groupNode.properties as Record<string, unknown>)).toEqual(["z", "x", "y"]);
    expect(groupNode.required).toEqual(["z", "x"]);
  });

  it("only touches the target field and is a no-op out of bounds", () => {
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [
        group("g", [
          ["x", false],
          ["y", false],
        ]),
        group("h", [
          ["p", false],
          ["q", false],
        ]),
      ],
      requiredOrder: [],
    };
    const moved = moveSubField(form, 0, 1, 0);
    expect(moved.fields[0]?.children.map((child) => child.name)).toEqual(["y", "x"]);
    expect(moved.fields[1]?.children.map((child) => child.name)).toEqual(["p", "q"]);
    expect(moveSubField(form, 0, 0, 0)).toBe(form);
    expect(moveSubField(form, 0, 0, 9)).toBe(form);
    expect(moveSubField(form, 7, 0, 1)).toBe(form);
  });

  it("moves sub-fields of array (list-of-objects) groups too", () => {
    const form: SchemaForm = {
      title: "",
      description: "",
      fields: [
        {
          name: "list",
          type: "array",
          description: "",
          required: false,
          children: [
            { name: "one", type: "string", description: "", required: true },
            { name: "two", type: "string", description: "", required: false },
          ],
          requiredOrder: ["one"],
        },
      ],
      requiredOrder: [],
    };
    const moved = moveSubField(form, 0, 1, 0);
    const schema = formToSchema(moved);
    const list = (schema.properties as Record<string, Record<string, unknown>>).list;
    expect(list).toBeDefined();
    const items = list.items as Record<string, unknown>;
    expect(Object.keys(items.properties as Record<string, unknown>)).toEqual(["two", "one"]);
    expect(items.required).toEqual(["one"]);
  });
});
