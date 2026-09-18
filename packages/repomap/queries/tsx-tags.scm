; tsx-tags.scm — igual que typescript-tags.scm (grammar tsx extiende typescript con JSX; mismos nodos).
; Define: docs/architecture/07-context-manager.md §2.2 paso 3 ("derivadas de las queries de Aider").
; Derivado de aider/queries/tree-sitter-languages/typescript-tags.scm (Aider-AI/aider, licencia Apache-2.0).
; Atribución completa en resources/grammars/NOTICE. Simplificado para el MVP de SaurioLLM: menos
; capturas que el original, alcanza para function/class/interface/method/type/enum + llamadas y tipos.

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(public_field_definition
  name: (property_identifier) @name.definition.field
  value: [(arrow_function) (function_expression)]) @definition.method

(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

(type_annotation
  (type_identifier) @name.reference.type) @reference.type

(extends_clause
  value: (identifier) @name.reference.class) @reference.class

(implements_clause
  (type_identifier) @name.reference.type) @reference.type
