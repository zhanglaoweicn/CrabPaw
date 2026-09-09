const EMPTY_OBJECT = { type: 'object', properties: {} };

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return EMPTY_OBJECT;

  let result = { ...schema };

  result = _fixEmptyProperties(result);
  result = _collapseArrayType(result);
  result = _collapseNullableAnyOf(result);
  result = _removeTopLevelCombinators(result);
  result = _ensureRequiredIsArray(result);
  result = _sanitizeDeep(result);

  return result;
}

function sanitizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) return tools;

  return tools.map(tool => {
    if (!tool.function?.parameters) return tool;

    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: sanitizeSchema(tool.function.parameters)
      }
    };
  });
}

function _fixEmptyProperties(schema) {
  if (schema.type === 'object' && !schema.properties) {
    return { ...schema, properties: {} };
  }
  return schema;
}

function _collapseArrayType(schema) {
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter(t => t !== 'null' && t !== 'None');
    if (nonNullTypes.length === 1) {
      const result = { ...schema, type: nonNullTypes[0] };
      if (schema.type.includes('null')) {
        result.nullable = true;
      }
      delete result.anyOf;
      return result;
    }
    if (nonNullTypes.length > 1) {
      return { ...schema, type: 'string' };
    }
    return { ...schema, type: 'string' };
  }
  return schema;
}

function _collapseNullableAnyOf(schema) {
  if (!schema.anyOf || !Array.isArray(schema.anyOf)) return schema;

  const nonNull = schema.anyOf.filter(s => s.type !== 'null' && s.type !== 'None');
  const hasNull = schema.anyOf.some(s => s.type === 'null' || s.type === 'None');

  if (hasNull && nonNull.length === 1) {
    const result = { ...nonNull[0], nullable: true };
    delete result.anyOf;
    return result;
  }

  return schema;
}

function _removeTopLevelCombinators(schema) {
  if (schema.allOf && Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    const merged = { ...schema.allOf[0], ...schema };
    delete merged.allOf;
    return merged;
  }

  if (schema.oneOf && Array.isArray(schema.oneOf) && schema.oneOf.length === 1) {
    const merged = { ...schema.oneOf[0], ...schema };
    delete merged.oneOf;
    return merged;
  }

  return schema;
}

function _ensureRequiredIsArray(schema) {
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    delete schema.required;
  }
  return schema;
}

function _sanitizeDeep(schema, depth = 0) {
  if (depth > 10) return schema;
  if (!schema || typeof schema !== 'object') return schema;

  if (schema.properties && typeof schema.properties === 'object') {
    const newProps = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      newProps[key] = _sanitizeDeep(val, depth + 1);
    }
    schema = { ...schema, properties: newProps };
  }

  if (schema.items && typeof schema.items === 'object') {
    schema = { ...schema, items: _sanitizeDeep(schema.items, depth + 1) };
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    schema = { ...schema, additionalProperties: _sanitizeDeep(schema.additionalProperties, depth + 1) };
  }

  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const collapsed = _collapseNullableAnyOf(schema);
    if (collapsed !== schema) return _sanitizeDeep(collapsed, depth);
    schema = { ...schema, anyOf: schema.anyOf.map(s => _sanitizeDeep(s, depth + 1)) };
  }

  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    schema = { ...schema, oneOf: schema.oneOf.map(s => _sanitizeDeep(s, depth + 1)) };
  }

  if (schema.allOf && Array.isArray(schema.allOf)) {
    schema = { ...schema, allOf: schema.allOf.map(s => _sanitizeDeep(s, depth + 1)) };
  }

  return schema;
}

module.exports = { sanitizeSchema, sanitizeToolDefinitions };
