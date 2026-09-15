/**
 * A small, dependency-free JSON Schema validator for the DeepBlend schemas.
 *
 * WHY NOT A LIBRARY
 * -----------------
 * The DeepBlend schemas use a deliberately narrow, closed subset of JSON Schema
 * draft 2020-12: type, additionalProperties, required, properties, items,
 * minItems/maxItems, minimum/maximum/exclusiveMinimum/exclusiveMaximum,
 * minLength/maxLength, pattern, enum, const, oneOf and local `#/$defs/...` refs.
 * That subset is ~200 lines of straightforward code, and writing it here buys
 * three things a dependency would not:
 *
 *  1. **Zero install surface.** This repository has no pnpm and no build step
 *     (M0 decision D4, SPEC §6.1 deviation #2). A dependency would have to be
 *     vendored by hand into a profile's node_modules.
 *  2. **Issue-path fidelity.** Validation output is consumed by the model, so a
 *     failure must read like `entities[2].transform.location[1]` and name the
 *     keyword that rejected it — not a library-formatted error string.
 *  3. **Honest failure on the unsupported subset.** Any keyword this validator
 *     does not implement is reported as an error while loading the SCHEMA, not
 *     silently ignored while validating DATA. A silently ignored constraint is
 *     worse than no validator at all, because it converts a rejected scene into
 *     an accepted one.
 *
 * The schemas themselves live in `deepblend/schemas/` per SPEC §5.2 and are
 * mirrored into this package's `lib/schemas/` so the published package is
 * self-contained. A contract test asserts the mirror is byte-identical, so the
 * two copies cannot drift.
 *
 * Owner: DeepBlend Studio — M1
 */

/** Keywords this validator understands. Anything else fails schema loading. */
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref',
  'title', 'description', 'default', 'examples',
  'type', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'enum', 'const',
  'oneOf',
])

/** JSON types as JSON Schema spells them. `integer` is handled separately. */
const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * @typedef {object} SchemaIssue
 * @property {string} path - JSON Pointer-ish data path, `''` for the root.
 * @property {string} keyword - the JSON Schema keyword that rejected the value.
 * @property {string} message - human-readable, safe to hand to the model.
 */

/** Thrown when a schema document itself is malformed or uses unsupported keywords. */
export class SchemaDefinitionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'SchemaDefinitionError'
  }
}

/** Render a data path as `a.b[0].c`, or `<root>`. */
function formatPath(segments) {
  if (segments.length === 0) return '<root>'
  let text = ''
  for (const segment of segments) {
    if (typeof segment === 'number') text += `[${segment}]`
    else if (text.length === 0) text = segment
    else text += `.${segment}`
  }
  return text
}

/** True when `value` satisfies one JSON type name. */
function matchesType(value, type) {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    // An integer is a number without a fractional part; 3.0 is a valid integer.
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/**
 * Compile a schema document into a reusable validator.
 *
 * Compilation walks the whole schema once and throws {@link SchemaDefinitionError}
 * for any unsupported keyword, so a typo in a schema can never become a silently
 * unenforced rule at validation time.
 *
 * @param {object} schema - a parsed JSON Schema document.
 * @param {{ id?: string }} [options]
 * @returns {(value: unknown) => SchemaIssue[]} validator returning `[]` when valid.
 */
export function compileSchema(schema, options = {}) {
  const label = options.id ?? schema?.$id ?? '<anonymous schema>'
  const root = schema

  /** Assert that only supported keywords appear anywhere in the document. */
  function assertSupported(node, trail) {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      throw new SchemaDefinitionError(`${label}: unexpected array at ${trail}`)
    }
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        throw new SchemaDefinitionError(
          `${label}: unsupported JSON Schema keyword "${key}" at ${trail || '<root>'}. ` +
            `Add it to SUPPORTED_KEYWORDS with real enforcement, or remove it — an ` +
            `unimplemented keyword would be silently unenforced.`,
        )
      }
    }
    for (const [key, value] of Object.entries(node)) {
      // `$defs` holds named sub-schemas; `oneOf` holds a list of sub-schemas.
      if (key === '$defs' && typeof value === 'object' && value !== null) {
        for (const [name, sub] of Object.entries(value)) assertSupported(sub, `$defs/${name}`)
      } else if (key === 'oneOf' && Array.isArray(value)) {
        value.forEach((sub, index) => assertSupported(sub, `${trail}#oneOf/${index}`))
      } else if (key === 'properties' && typeof value === 'object' && value !== null) {
        for (const [name, sub] of Object.entries(value)) assertSupported(sub, `${trail}/properties/${name}`)
      } else if ((key === 'items' || key === 'additionalProperties') && typeof value === 'object' && value !== null) {
        assertSupported(value, `${trail}/${key}`)
      }
    }
  }

  assertSupported(root, '')

  /** Resolve a local `#/...` JSON pointer. External refs are not supported. */
  function resolveRef(reference) {
    if (typeof reference !== 'string' || !reference.startsWith('#/')) {
      throw new SchemaDefinitionError(
        `${label}: only local "#/..." $ref values are supported, got "${reference}".`,
      )
    }
    let node = root
    for (const rawToken of reference.slice(2).split('/')) {
      const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~')
      if (typeof node !== 'object' || node === null || !(token in node)) {
        throw new SchemaDefinitionError(`${label}: $ref "${reference}" does not resolve.`)
      }
      node = node[token]
    }
    return node
  }

  /**
   * Validate `value` against `node`, appending to `issues`.
   * @param {unknown} value
   * @param {any} node
   * @param {(string|number)[]} path
   * @param {SchemaIssue[]} issues
   */
  function visit(value, node, path, issues) {
    if (typeof node !== 'object' || node === null) return

    if (node.$ref !== undefined) {
      // A `$ref` in this subset is the only constraint on the node, matching the
      // "sibling keywords are ignored" behaviour of the 2020-12 dialect.
      visit(value, resolveRef(node.$ref), path, issues)
      return
    }

    if (Array.isArray(node.oneOf)) {
      const survivors = []
      for (const branch of node.oneOf) {
        const branchIssues = []
        visit(value, branch, path, branchIssues)
        if (branchIssues.length === 0) survivors.push(branch)
      }
      if (survivors.length !== 1) {
        issues.push({
          path: formatPath(path),
          keyword: 'oneOf',
          message: survivors.length === 0
            ? `value matches none of the ${node.oneOf.length} allowed operation shapes`
            : `value matches ${survivors.length} of the ${node.oneOf.length} allowed operation shapes`,
        })
        return
      }
      return
    }

    if (node.type !== undefined) {
      const declared = Array.isArray(node.type) ? node.type : [node.type]
      for (const type of declared) {
        if (!JSON_TYPES.has(type)) {
          throw new SchemaDefinitionError(`${label}: unknown type "${type}" at ${formatPath(path)}`)
        }
      }
      if (!declared.some(type => matchesType(value, type))) {
        issues.push({
          path: formatPath(path),
          keyword: 'type',
          message: `expected ${declared.join(' or ')}, received ${
            value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
          }`,
        })
        // Every remaining check would be guesswork against the wrong type.
        return
      }
    }

    if (node.const !== undefined && value !== node.const) {
      issues.push({
        path: formatPath(path),
        keyword: 'const',
        message: `expected the literal ${JSON.stringify(node.const)}, received ${JSON.stringify(value)}`,
      })
    }

    if (Array.isArray(node.enum) && !node.enum.some(allowed => allowed === value)) {
      issues.push({
        path: formatPath(path),
        keyword: 'enum',
        message: `expected one of ${node.enum.map(entry => JSON.stringify(entry)).join(', ')}, received ${JSON.stringify(value)}`,
      })
    }

    if (typeof value === 'string') {
      if (typeof node.minLength === 'number' && value.length < node.minLength) {
        issues.push({
          path: formatPath(path),
          keyword: 'minLength',
          message: `string is ${value.length} characters, minimum is ${node.minLength}`,
        })
      }
      if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
        issues.push({
          path: formatPath(path),
          keyword: 'maxLength',
          message: `string is ${value.length} characters, maximum is ${node.maxLength}`,
        })
      }
      if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
        issues.push({
          path: formatPath(path),
          keyword: 'pattern',
          message: `"${value}" does not match ${node.pattern}`,
        })
      }
    }

    if (typeof value === 'number') {
      if (typeof node.minimum === 'number' && value < node.minimum) {
        issues.push({ path: formatPath(path), keyword: 'minimum', message: `${value} is below ${node.minimum}` })
      }
      if (typeof node.maximum === 'number' && value > node.maximum) {
        issues.push({ path: formatPath(path), keyword: 'maximum', message: `${value} is above ${node.maximum}` })
      }
      if (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum) {
        issues.push({
          path: formatPath(path),
          keyword: 'exclusiveMinimum',
          message: `${value} must be greater than ${node.exclusiveMinimum}`,
        })
      }
      if (typeof node.exclusiveMaximum === 'number' && value >= node.exclusiveMaximum) {
        issues.push({
          path: formatPath(path),
          keyword: 'exclusiveMaximum',
          message: `${value} must be less than ${node.exclusiveMaximum}`,
        })
      }
    }

    if (Array.isArray(value)) {
      if (typeof node.minItems === 'number' && value.length < node.minItems) {
        issues.push({
          path: formatPath(path),
          keyword: 'minItems',
          message: `array has ${value.length} items, minimum is ${node.minItems}`,
        })
      }
      if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
        issues.push({
          path: formatPath(path),
          keyword: 'maxItems',
          message: `array has ${value.length} items, maximum is ${node.maxItems}`,
        })
      }
      if (node.items !== undefined) {
        value.forEach((item, index) => visit(item, node.items, [...path, index], issues))
      }
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const properties = node.properties ?? {}
      for (const name of node.required ?? []) {
        if (!Object.hasOwn(value, name) || value[name] === undefined) {
          issues.push({
            path: formatPath([...path, name]),
            keyword: 'required',
            message: `required property "${name}" is missing`,
          })
        }
      }
      for (const [name, member] of Object.entries(value)) {
        if (Object.hasOwn(properties, name)) {
          visit(member, properties[name], [...path, name], issues)
          continue
        }
        if (node.additionalProperties === false) {
          issues.push({
            path: formatPath([...path, name]),
            keyword: 'additionalProperties',
            message: `unknown property "${name}" is not permitted here`,
          })
        } else if (typeof node.additionalProperties === 'object' && node.additionalProperties !== null) {
          visit(member, node.additionalProperties, [...path, name], issues)
        }
      }
    }
  }

  return function validate(value) {
    const issues = []
    visit(value, root, [], issues)
    return issues
  }
}

/**
 * Render issues as a compact, model-readable list.
 * @param {SchemaIssue[]} issues
 * @returns {string}
 */
export function formatIssues(issues) {
  return issues.map(issue => `${issue.path}: ${issue.message} [${issue.keyword}]`).join('\n')
}
