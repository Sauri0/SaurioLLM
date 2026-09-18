; javascript-tags.scm — queries de tags para JavaScript (paquete @saurio/repomap).
; Define: docs/architecture/07-context-manager.md §2.2 paso 3 ("derivadas de las queries de Aider").
; Derivado de aider/queries/tree-sitter-languages/javascript-tags.scm (Aider-AI/aider, licencia Apache-2.0).
; Atribución completa en resources/grammars/NOTICE. Simplificado para el MVP de SaurioLLM.

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(class_declaration
  name: (identifier) @name.definition.class) @definition.class

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

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

(class_heritage
  (identifier) @name.reference.class) @reference.class
