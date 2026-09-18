; python-tags.scm — queries de tags para Python (paquete @saurio/repomap).
; Define: docs/architecture/07-context-manager.md §2.2 paso 3 ("derivadas de las queries de Aider").
; Derivado de aider/queries/tree-sitter-languages/python-tags.scm (Aider-AI/aider, licencia Apache-2.0).
; Atribución completa en resources/grammars/NOTICE. Simplificado para el MVP de SaurioLLM.

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(class_definition
  name: (identifier) @name.definition.class) @definition.class

(call
  function: (identifier) @name.reference.call) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name.reference.call)) @reference.call

(class_definition
  superclasses: (argument_list
    (identifier) @name.reference.class)) @reference.class
