import { PYTHON_LIBRARY_EFFECTS } from './python-library-effects'

const PYTHON_LIBRARY_EFFECTS_SOURCE = JSON.stringify(JSON.stringify(PYTHON_LIBRARY_EFFECTS))

const PYTHON_ANALYZER = String.raw`
import ast, json, re, sys

LIBRARY_EFFECTS = json.loads(${PYTHON_LIBRARY_EFFECTS_SOURCE})

MUTATING_METHODS = {"append", "extend", "insert", "remove", "pop", "clear", "sort", "reverse", "update", "setdefault", "add", "discard"}
DYNAMIC_CALLS = {"eval", "exec", "globals", "locals", "vars", "compile", "__import__"}
SAFE_CALLS = {"abs", "all", "any", "bool", "bytes", "complex", "dict", "enumerate", "filter", "float", "frozenset", "hash", "id", "int", "len", "list", "map", "max", "min", "print", "range", "repr", "reversed", "round", "set", "slice", "sorted", "str", "sum", "tuple", "type", "zip"}
EXTERNAL_READ_CALLS = {"open"}
SCOPED_MUTATION_CALLS = {"next"}
SAFE_LITERAL_METHODS = {"capitalize", "casefold", "endswith", "format", "join", "lower", "lstrip", "replace", "rstrip", "split", "startswith", "strip", "title", "upper"}
SIMPLE_FORMULA_PATTERN = re.compile(r'^[A-Za-z0-9_~+*:/.-]+(?:\s+[A-Za-z0-9_~+*:/.-]+)*$')

def simple_formula_names(node):
    if not isinstance(node, ast.Constant) or not isinstance(node.value, str): return None
    formula = node.value.strip()
    if formula.count('~') != 1 or not SIMPLE_FORMULA_PATTERN.fullmatch(formula): return None
    return set(re.findall(r'[A-Za-z_]\w*', formula))

def root_name(node):
    while isinstance(node, (ast.Attribute, ast.Subscript)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None

def member_name(node):
    if isinstance(node, ast.Attribute): return node.attr
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, (str, int)): return str(node.slice.value)
    return None

def dynamic_member_write(node):
    if isinstance(node, ast.Attribute):
        type_wide = isinstance(node.value, ast.Attribute) and node.value.attr == '__class__'
        return (member_name(node), type_wide)
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == '__dict__': return (member_name(node), False)
    return None

def python_field_relationship(node):
    if isinstance(node, ast.Constant): return 'value'
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        if node.func.id in {'bool', 'bytes', 'complex', 'float', 'frozenset', 'int', 'str'}: return 'value'
        if node.func.id in {'dict', 'list', 'set'}: return 'reference'
    if isinstance(node, (ast.Dict, ast.List, ast.Set, ast.ListComp, ast.SetComp, ast.DictComp)): return 'reference'
    return 'unknown'

def static_integer(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool): return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = static_integer(node.operand)
        if value is not None: return value if isinstance(node.op, ast.UAdd) else -value
    return None

def static_scalar(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes, int, float, complex, bool, type(None))): return True
    return static_integer(node) is not None

def static_nonempty_iterable(node):
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return bool(node.elts) and all(static_scalar(element) for element in node.elts)
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.keywords: return False
    if node.func.id == 'range' and 1 <= len(node.args) <= 3:
        values = [static_integer(argument) for argument in node.args]
        if any(value is None for value in values): return False
        try: return len(range(*values)) > 0
        except (TypeError, ValueError): return False
    if node.func.id in {'enumerate', 'reversed'} and len(node.args) == 1:
        return static_nonempty_iterable(node.args[0])
    if node.func.id == 'zip' and node.args:
        return all(static_nonempty_iterable(argument) for argument in node.args)
    return False

def simple_loop_target(node):
    if isinstance(node, ast.Name): return True
    if isinstance(node, (ast.Tuple, ast.List)) and node.elts:
        return all(simple_loop_target(element) for element in node.elts)
    return False

def loop_target_names(node):
    if isinstance(node, (ast.Tuple, ast.List)):
        return [name for element in node.elts for name in loop_target_names(element)]
    return [node.id] if isinstance(node, ast.Name) else []

class EffectOnlyLoopBody(ast.NodeVisitor):
    def __init__(self): self.safe = True
    def reject(self, node): self.safe = False
    visit_Assign = reject
    visit_AnnAssign = reject
    visit_AugAssign = reject
    visit_NamedExpr = reject
    visit_Delete = reject
    visit_Import = reject
    visit_ImportFrom = reject
    visit_FunctionDef = reject
    visit_AsyncFunctionDef = reject
    visit_ClassDef = reject
    visit_Lambda = reject
    visit_If = reject
    visit_IfExp = reject
    visit_BoolOp = reject
    visit_For = reject
    visit_AsyncFor = reject
    visit_While = reject
    visit_Try = reject
    visit_TryStar = reject
    visit_Match = reject
    visit_With = reject
    visit_AsyncWith = reject
    visit_ListComp = reject
    visit_SetComp = reject
    visit_DictComp = reject
    visit_GeneratorExp = reject
    visit_Break = reject
    visit_Continue = reject
    visit_Return = reject
    visit_Raise = reject
    visit_Yield = reject
    visit_YieldFrom = reject

def effect_only_loop_body(statements):
    visitor = EffectOnlyLoopBody()
    for statement in statements:
        visitor.visit(statement)
        if not visitor.safe: return False
    return True

def scoped_effect_loops(tree):
    loaded_after = {}
    for candidate in ast.walk(tree):
        if isinstance(candidate, ast.Name) and isinstance(candidate.ctx, ast.Load):
            loaded_after.setdefault(candidate.id, []).append(getattr(candidate, 'lineno', 0))
    result = set()
    for candidate in ast.walk(tree):
        if not isinstance(candidate, ast.For) or not simple_loop_target(candidate.target) or not effect_only_loop_body(candidate.body): continue
        target_names = loop_target_names(candidate.target)
        body_loads = {
            child.id
            for statement in candidate.body
            for child in ast.walk(statement)
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load)
        }
        if not any(name in body_loads for name in target_names): continue
        end_line = getattr(candidate, 'end_lineno', getattr(candidate, 'lineno', 0))
        if all(not any(line > end_line for line in loaded_after.get(name, [])) for name in target_names): result.add(id(candidate))
    return result

class MethodEffectVisitor(ast.NodeVisitor):
    def __init__(self, receiver):
        self.effect = 'read'
        self.receiver = receiver
        self.control_depth = 0
        self.namespace_unknown = False

    def mutate(self):
        if self.control_depth > 0: self.unknown()
        elif self.effect != 'unknown': self.effect = 'mutate'

    def unknown(self, namespace=False):
        self.effect = 'unknown'
        if namespace: self.namespace_unknown = True

    def visit_FunctionDef(self, node): self.unknown()
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_Lambda(self, node): self.unknown()
    def visit_Global(self, node): self.unknown(True)
    def visit_Nonlocal(self, node): self.unknown(True)
    def visit_ListComp(self, node): self.unknown()
    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp

    def visit_control(self, node):
        self.control_depth += 1
        self.generic_visit(node)
        self.control_depth -= 1

    visit_If = visit_control
    visit_For = visit_control
    visit_AsyncFor = visit_control
    visit_While = visit_control
    visit_Try = visit_control
    visit_Match = visit_control

    def visit_Assign(self, node):
        if any(root_name(target) == self.receiver for target in node.targets): self.mutate()
        elif any(isinstance(target, (ast.Attribute, ast.Subscript)) for target in node.targets): self.unknown(True)
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        if root_name(node.target) == self.receiver: self.mutate()
        elif isinstance(node.target, (ast.Attribute, ast.Subscript)): self.unknown(True)
        self.generic_visit(node)

    def visit_AugAssign(self, node):
        if root_name(node.target) == self.receiver: self.mutate()
        elif isinstance(node.target, (ast.Attribute, ast.Subscript)): self.unknown(True)
        self.generic_visit(node)

    def visit_Delete(self, node):
        if any(root_name(target) == self.receiver for target in node.targets): self.mutate()
        elif any(isinstance(target, (ast.Attribute, ast.Subscript)) for target in node.targets): self.unknown(True)
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id in SAFE_CALLS:
            self.generic_visit(node)
            return
        if isinstance(node.func, ast.Attribute) and root_name(node.func.value) == self.receiver:
            inplace = any(keyword.arg == 'inplace' and isinstance(keyword.value, ast.Constant) and keyword.value.value is True for keyword in node.keywords)
            if node.func.attr in MUTATING_METHODS or inplace: self.mutate()
            else: self.unknown(True)
        else: self.unknown(True)
        self.generic_visit(node)

class FieldVisitor(ast.NodeVisitor):
    def __init__(self, receiver, record):
        self.receiver = receiver
        self.record = record

    def visit_FunctionDef(self, node): return
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_Lambda(self, node): return
    def visit_ListComp(self, node): return
    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp

    def visit_Assign(self, node):
        for target in node.targets: self.record(target, node.value, self.receiver)
        self.generic_visit(node.value)

    def visit_AnnAssign(self, node):
        self.record(node.target, node.value, self.receiver)
        if node.value is not None: self.visit(node.value)

    def visit_AugAssign(self, node):
        self.record(node.target, None, self.receiver)
        self.visit(node.value)

class MethodNameVisitor(ast.NodeVisitor):
    def __init__(self):
        self.locals = set()
        self.globals = set()
        self.loaded = set()
        self.safe_calls = set()

    def visit_FunctionDef(self, node): return
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_Lambda(self, node): return
    def visit_Global(self, node): self.globals.update(node.names)
    def visit_Nonlocal(self, node): self.globals.update(node.names)
    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load): self.loaded.add(node.id)
        elif isinstance(node.ctx, (ast.Store, ast.Del)): self.locals.add(node.id)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id in SAFE_CALLS: self.safe_calls.add(node.func.id)
        self.generic_visit(node)

def summarize_class(node):
    if node.bases or node.keywords or node.decorator_list: return None
    methods = []
    fields = {}
    def record_field(target, value, receiver):
        if not isinstance(target, ast.Attribute) or root_name(target) != receiver: return
        previous = fields.get(target.attr)
        if value is None and previous is not None: return
        relationship = python_field_relationship(value) if value is not None else 'unknown'
        fields[target.attr] = relationship if previous in {None, relationship} else 'unknown'
    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if item.decorator_list: return None
            positional = [*item.args.posonlyargs, *item.args.args]
            if not positional: return None
            receiver = positional[0].arg
            visitor = MethodEffectVisitor(receiver)
            names = MethodNameVisitor()
            names.locals.update(argument.arg for argument in [*item.args.posonlyargs, *item.args.args, *item.args.kwonlyargs])
            if item.args.vararg: names.locals.add(item.args.vararg.arg)
            if item.args.kwarg: names.locals.add(item.args.kwarg.arg)
            for statement in item.body: visitor.visit(statement)
            for statement in item.body: names.visit(statement)
            shadowed_safe_calls = names.safe_calls & (names.locals - names.globals)
            if shadowed_safe_calls: visitor.unknown(True)
            used_names = sorted(names.loaded - (names.locals - names.globals) - {receiver})
            methods.append({'name': item.name, 'effect': visitor.effect, 'usedNames': used_names, 'safeCallNames': sorted(names.safe_calls - shadowed_safe_calls), 'unknownScope': 'namespace' if visitor.namespace_unknown else 'receiver'})
            field_visitor = FieldVisitor(receiver, record_field)
            for statement in item.body: field_visitor.visit(statement)
        elif isinstance(item, ast.Pass) or (isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str)):
            continue
        else: return None
    return {'name': node.name, 'kind': 'python-class', 'fields': [{'name': name, 'relationship': fields[name]} for name in sorted(fields)], 'methods': methods}

class Analyzer(ast.NodeVisitor):
    def __init__(self, scoped_loops=None):
        self.defined = set()
        self.used = {}
        self.prior_used = {}
        self.mutated = set()
        self.possibly_mutated = set()
        self.aliases = {}
        self.possible_aliases = set()
        self.builtin_containers = set()
        self.safe_call_names = set()
        self.safe_call_argument_names = set()
        self.possibly_used = set()
        self.type_summaries = []
        self.type_bindings = []
        self.receiver_calls = []
        self.member_writes = []
        self.constructor_nodes = set()
        self.call_result_names = {}
        self.unknown = set()
        self.control_depth = 0
        self.local_scopes = []
        self.builtin_module_names = {"builtins", "__builtins__"}
        self.imported_modules = {}
        self.imported_functions = {}
        self.scoped_loops = scoped_loops or set()

    def add_used(self, name):
        self.used[name] = self.used.get(name, 0) + 1
        if name not in self.defined: self.prior_used[name] = self.prior_used.get(name, 0) + 1

    def remove_used(self, name):
        count = self.used.get(name, 0)
        if count <= 1: self.used.pop(name, None)
        else: self.used[name] = count - 1
        prior_count = self.prior_used.get(name, 0)
        if prior_count <= 1: self.prior_used.pop(name, None)
        else: self.prior_used[name] = prior_count - 1

    def add_possible_alias(self, target, source, access=None, member=None):
        self.possible_aliases.add((target, source, access or '', member or ''))

    def visible_root_name(self, node):
        name = root_name(node)
        for scope in reversed(self.local_scopes):
            if name in scope: return scope[name]
        return name

    def visible_roots(self, nodes):
        result = []
        for node in nodes:
            for name in self.expression_visible_roots(node):
                if name not in result: result.append(name)
        return result

    def expression_visible_roots(self, node):
        name = self.visible_root_name(node)
        if name: return [name]
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return self.visible_roots(node.elts)
        if isinstance(node, ast.Dict):
            return self.visible_roots([item for pair in zip(node.keys, node.values) for item in pair if item is not None])
        return []

    def receiver_root_name(self, node):
        name = self.visible_root_name(node)
        if name: return name
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            return self.receiver_root_name(node.value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            return self.receiver_root_name(node.func.value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            return self.imported_functions.get(node.func.id, node.func.id)
        return None

    def receiver_call_chain(self, node):
        if isinstance(node, ast.Subscript):
            return self.receiver_call_chain(node.value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            return self.receiver_call_chain(node.func.value) + [node.func.attr]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            return ['__call__']
        return []

    def receiver_chain_first_arguments(self, node):
        if isinstance(node, ast.Subscript):
            return self.receiver_chain_first_arguments(node.value)
        if isinstance(node, ast.Call):
            prior = self.receiver_chain_first_arguments(node.func.value) if isinstance(node.func, ast.Attribute) else []
            first = self.expression_visible_roots(node.args[0]) if node.args else []
            return prior + [first]
        return []

    def receiver_chain_arguments(self, node):
        if isinstance(node, ast.Subscript):
            return self.receiver_chain_arguments(node.value)
        if isinstance(node, ast.Call):
            prior = self.receiver_chain_arguments(node.func.value) if isinstance(node.func, ast.Attribute) else []
            keywords = [self.keyword_argument_record(keyword) for keyword in node.keywords]
            return prior + [{'positionalArgumentNames': [self.expression_visible_roots(argument) for argument in node.args], 'positionalStaticBooleans': [argument.value if isinstance(argument, ast.Constant) and isinstance(argument.value, bool) else None for argument in node.args], 'keywordArguments': keywords}]
        return []

    def receiver_value_roots(self, node):
        if isinstance(node, ast.Subscript):
            return self.receiver_value_roots(node.value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            effect = self.library_call_effect(node)
            base = self.receiver_value_roots(node.func.value)
            if effect:
                first_keyword = effect.get('firstArgumentKeyword')
                first = next((keyword.value for keyword in node.keywords if keyword.arg == first_keyword), node.args[0] if node.args else None)
                first_roots = self.expression_visible_roots(first) if first is not None else []
                alias_keyword = effect.get('returnsAliasOfKeyword')
                alias_value = next((keyword.value for keyword in node.keywords if keyword.arg == alias_keyword), None)
                if alias_value is not None: return self.expression_visible_roots(alias_value)
                if effect.get('returnsAliasOfReceiver'): return base
                if effect.get('returnsPossibleAliasOf') == 'receiver': return base
                if effect.get('returnsPossibleAliasOf') == 'firstArgument': return first_roots
                conditional = effect.get('returnsPossibleAliasWhenKeywordFalse')
                if conditional:
                    keyword = next((keyword for keyword in node.keywords if keyword.arg == conditional.get('keyword')), None)
                    position = conditional.get('positionalArgument')
                    flag = keyword.value.value if keyword is not None and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, bool) else node.args[position].value if isinstance(position, int) and position < len(node.args) and isinstance(node.args[position], ast.Constant) and isinstance(node.args[position].value, bool) else None
                    if flag is not True:
                        roots = []
                        for source in conditional.get('sources', []):
                            if source == 'receiver': roots.extend(base)
                            elif source == 'firstArgument': roots.extend(first_roots)
                            elif source == 'secondArgument':
                                second_keyword = effect.get('secondArgumentKeyword')
                                second = next((item.value for item in node.keywords if item.arg == second_keyword), node.args[1] if len(node.args) > 1 else None)
                                if second is not None: roots.extend(self.expression_visible_roots(second))
                            elif source == 'arguments': roots.extend(self.visible_roots(list(node.args) + [item.value for item in node.keywords]))
                        return list(dict.fromkeys(roots))
                if effect.get('returnType') or effect.get('destructuredReturnTypes'): return []
            if node.func.attr == 'merge':
                copy_keyword = next((item for item in node.keywords if item.arg == 'copy'), None)
                copy_position = 9
                has_copy_position = copy_position < len(node.args)
                copy_flag = copy_keyword.value.value if copy_keyword is not None and isinstance(copy_keyword.value, ast.Constant) and isinstance(copy_keyword.value.value, bool) else node.args[copy_position].value if has_copy_position and isinstance(node.args[copy_position], ast.Constant) and isinstance(node.args[copy_position].value, bool) else None
                if copy_keyword is not None or has_copy_position:
                    if copy_flag is not True:
                        right_keyword = next((item.value for item in node.keywords if item.arg == 'right'), None)
                        right = right_keyword if right_keyword is not None else node.args[0] if node.args else None
                        if right is not None: return list(dict.fromkeys(base + self.expression_visible_roots(right)))
            return base
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            effect = self.library_call_effect(node)
            first = node.args[0] if node.args else None
            first_roots = self.expression_visible_roots(first) if first is not None else []
            if effect:
                alias_keyword = effect.get('returnsAliasOfKeyword')
                alias_value = next((keyword.value for keyword in node.keywords if keyword.arg == alias_keyword), None)
                if alias_value is not None: return self.expression_visible_roots(alias_value)
                if effect.get('returnsPossibleAliasOf') == 'firstArgument': return first_roots
                if effect.get('returnType') or effect.get('destructuredReturnTypes'): return []
            return self.visible_roots(list(node.args) + [item.value for item in node.keywords])
        name = self.visible_root_name(node)
        return [name] if name else []

    def has_local_root(self, node):
        name = root_name(node)
        if any(name in scope for scope in self.local_scopes): return True
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return any(self.has_local_root(element) for element in node.elts)
        if isinstance(node, ast.Dict):
            return any(self.has_local_root(item) for item in [item for pair in zip(node.keys, node.values) for item in pair if item is not None])
        return False

    def callable_references(self, node, container=None):
        suffix = {'container': container} if container else {}
        if isinstance(node, ast.Name):
            alias = self.aliases.get(node.id, node.id)
            return [{'root': self.imported_functions.get(alias, alias), **suffix}]
        if isinstance(node, ast.Attribute):
            root = self.visible_root_name(node.value)
            alias = self.aliases.get(root, root) if root else None
            return [{'root': alias, 'member': node.attr, **suffix}] if alias else []
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return [reference for element in node.elts for reference in self.callable_references(element, 'list')]
        if isinstance(node, ast.Dict):
            return [reference for value in node.values for reference in self.callable_references(value, 'dict')]
        return []

    def keyword_argument_record(self, keyword, track_local=False):
        roots = self.visible_roots([keyword.value])
        local = track_local and self.has_local_root(keyword.value)
        static_boolean = keyword.value.value if isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, bool) else None
        return {'name': keyword.arg or '**', 'argumentNames': [] if local else roots, 'possibleArgumentNames': roots if local else [], 'staticBoolean': static_boolean, 'callableReferences': self.callable_references(keyword.value)}

    def add_library_summaries(self):
        existing = {summary['name'] for summary in self.type_summaries}
        for name, summary in LIBRARY_EFFECTS.items():
            if name in existing: continue
            methods = []
            for method_name, effect in summary['methods'].items():
                method = {'name': method_name, 'effect': effect['effect']}
                if effect.get('returnType'): method['returnType'] = effect['returnType']
                if effect.get('destructuredReturnTypes'): method['destructuredReturnTypes'] = effect['destructuredReturnTypes']
                if effect.get('mutatesKeyword'): method['mutatesKeyword'] = effect['mutatesKeyword']
                methods.append(method)
            self.type_summaries.append({'name': name, 'kind': 'python-module' if summary['kind'] == 'module' else 'python-class', 'fields': [], 'methods': methods})

    def bind_library_module(self, target, module):
        if module not in LIBRARY_EFFECTS or LIBRARY_EFFECTS[module]['kind'] != 'module': return
        self.add_library_summaries()
        self.imported_modules[target] = module
        if target != module: self.aliases[target] = module
        self.type_bindings.append({'target': target, 'typeName': module, 'argumentNames': []})

    def bind_library_function(self, target, module, member):
        summary = LIBRARY_EFFECTS.get(module)
        effect = summary.get('methods', {}).get(member) if summary else None
        if not effect: return
        self.add_library_summaries()
        callable_type = 'python-callable:' + module + '.' + member
        method = {'name': '__call__', 'effect': effect['effect']}
        if effect.get('returnType'): method['returnType'] = effect['returnType']
        if effect.get('destructuredReturnTypes'): method['destructuredReturnTypes'] = effect['destructuredReturnTypes']
        if effect.get('mutatesKeyword'): method['mutatesKeyword'] = effect['mutatesKeyword']
        if not any(existing['name'] == callable_type for existing in self.type_summaries):
            self.type_summaries.append({'name': callable_type, 'kind': 'python-class', 'fields': [], 'methods': [method]})
        self.type_bindings.append({'target': target, 'typeName': callable_type, 'argumentNames': []})
        self.imported_functions[target] = callable_type

    def bind_unknown_import(self, target, module, member):
        callable_type = 'python-callable:unknown.' + module + '.' + member
        if not any(existing['name'] == callable_type for existing in self.type_summaries):
            self.type_summaries.append({'name': callable_type, 'kind': 'python-class', 'fields': [], 'methods': [{'name': '__call__', 'effect': 'unknown', 'unknownScope': 'namespace'}]})
        self.type_bindings.append({'target': target, 'typeName': callable_type, 'argumentNames': []})
        self.imported_functions[target] = callable_type

    def library_call_effect(self, node):
        if isinstance(node.func, ast.Name):
            callable_type = self.imported_functions.get(node.func.id, '')
            prefix = 'python-callable:'
            if not callable_type.startswith(prefix): return None
            canonical = callable_type[len(prefix):]
            modules = sorted((name for name, summary in LIBRARY_EFFECTS.items() if summary.get('kind') == 'module' and canonical.startswith(name + '.')), key=len, reverse=True)
            if not modules: return None
            module = modules[0]
            return LIBRARY_EFFECTS.get(module, {}).get('methods', {}).get(canonical[len(module) + 1:])
        if not isinstance(node.func, ast.Attribute): return None
        receiver = self.visible_root_name(node.func.value)
        module = self.imported_modules.get(receiver)
        if not module: return None
        return LIBRARY_EFFECTS.get(module, {}).get('methods', {}).get(node.func.attr)

    def assigned_names(self, node):
        return loop_target_names(node)

    def clear_alias(self, name, conditional=False):
        source = self.aliases.pop(name, None)
        if source:
            if conditional: self.add_possible_alias(name, source)
            else: self.remove_used(source)

    def prepare_assignment(self, target_names):
        conditional = self.control_depth > 0
        if conditional: self.unknown.add('control-flow')
        for name in target_names:
            self.imported_modules.pop(name, None)
            self.imported_functions.pop(name, None)
            self.type_bindings = [binding for binding in self.type_bindings if binding['target'] != name]
            self.type_summaries = [summary for summary in self.type_summaries if summary['name'] != name]
            self.builtin_containers.discard(name)
            for target, source in list(self.aliases.items()):
                if source == name:
                    self.add_possible_alias(target, source)
                    self.aliases.pop(target, None)
                    self.unknown.add('alias-rebind')
            self.clear_alias(name, conditional)

    def visit_control(self, node):
        self.unknown.add('control-flow')
        self.control_depth += 1
        self.generic_visit(node)
        self.control_depth -= 1

    def visit_Name(self, node):
        if any(node.id in scope for scope in self.local_scopes): return
        if isinstance(node.ctx, ast.Load): self.add_used(node.id)
        elif isinstance(node.ctx, ast.Store): self.defined.add(node.id)
        elif isinstance(node.ctx, ast.Del):
            self.prepare_assignment([node.id])
            self.mutated.add(node.id)

    def visit_Import(self, node):
        names = [alias.asname or alias.name.split('.')[0] for alias in node.names]
        self.prepare_assignment(names)
        for alias in node.names:
            name = alias.asname or alias.name.split('.')[0]
            self.defined.add(name)
            if alias.name == 'builtins':
                self.builtin_module_names.add(name)
                if name != 'builtins': self.aliases[name] = 'builtins'
            self.bind_library_module(name, alias.name)

    def visit_ImportFrom(self, node):
        self.prepare_assignment([alias.asname or alias.name for alias in node.names if alias.name != '*'])
        for alias in node.names:
            if alias.name == '*': self.unknown.add('wildcard-import')
            else:
                name = alias.asname or alias.name
                self.defined.add(name)
                if node.module == 'builtins' and alias.name == '__dict__':
                    self.add_possible_alias(name, 'builtins', 'attribute')
                if node.module:
                    self.bind_library_module(name, node.module + '.' + alias.name)
                    self.bind_library_function(name, node.module, alias.name)
                    if name not in self.imported_modules and name not in self.imported_functions:
                        self.bind_unknown_import(name, node.module, alias.name)

    def visit_Assign(self, node):
        target_names = [name for target in node.targets for name in self.assigned_names(target)]
        if isinstance(node.value, ast.Call): self.call_result_names[id(node.value)] = target_names
        alias_source = self.aliases.get(node.value.id, node.value.id) if isinstance(node.value, ast.Name) else None
        member_source = self.visible_root_name(node.value) if isinstance(node.value, (ast.Attribute, ast.Subscript)) else None
        member_access = 'subscript' if isinstance(node.value, ast.Subscript) else 'attribute'
        member = member_name(node.value) if member_source else None
        conditional_sources = {self.visible_root_name(value) for value in [node.value.body, node.value.orelse]} if isinstance(node.value, ast.IfExp) else set()
        conditional_sources.discard(None)
        constructor = len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id not in SAFE_CALLS | DYNAMIC_CALLS | EXTERNAL_READ_CALLS | SCOPED_MUTATION_CALLS and node.value.func.id not in self.imported_functions
        constructor_arguments = set()
        if constructor:
            constructor_arguments = {self.visible_root_name(value) for value in list(node.value.args) + [keyword.value for keyword in node.value.keywords]}
            constructor_arguments.discard(None)
            self.constructor_nodes.add(id(node.value))
        self.visit(node.value)
        self.prepare_assignment(target_names)
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and conditional_sources:
            self.unknown.add('conditional-expression')
            for source in conditional_sources: self.add_possible_alias(node.targets[0].id, source)
        elif len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Name):
            if self.control_depth > 0: self.add_possible_alias(node.targets[0].id, alias_source)
            else: self.aliases[node.targets[0].id] = alias_source
        elif len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and isinstance(node.value, (ast.Attribute, ast.Subscript)):
            if member_source: self.add_possible_alias(node.targets[0].id, member_source, member_access, member)
        elif constructor:
            self.type_bindings.append({'target': node.targets[0].id, 'typeName': node.value.func.id, 'argumentNames': sorted(constructor_arguments)})
        elif len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and isinstance(node.value, (ast.Dict, ast.List, ast.Tuple)):
            self.builtin_containers.add(node.targets[0].id)
        for target in node.targets: self.visit(target)

    def visit_AnnAssign(self, node):
        target_names = self.assigned_names(node.target)
        if isinstance(node.value, ast.Call): self.call_result_names[id(node.value)] = target_names
        alias_source = self.aliases.get(node.value.id, node.value.id) if isinstance(node.value, ast.Name) else None
        member_source = self.visible_root_name(node.value) if isinstance(node.value, (ast.Attribute, ast.Subscript)) else None
        member_access = 'subscript' if isinstance(node.value, ast.Subscript) else 'attribute'
        member = member_name(node.value) if member_source else None
        conditional_sources = {self.visible_root_name(value) for value in [node.value.body, node.value.orelse]} if isinstance(node.value, ast.IfExp) else set()
        conditional_sources.discard(None)
        constructor = isinstance(node.target, ast.Name) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id not in SAFE_CALLS | DYNAMIC_CALLS | EXTERNAL_READ_CALLS | SCOPED_MUTATION_CALLS and node.value.func.id not in self.imported_functions
        constructor_arguments = set()
        if constructor:
            constructor_arguments = {self.visible_root_name(value) for value in list(node.value.args) + [keyword.value for keyword in node.value.keywords]}
            constructor_arguments.discard(None)
            self.constructor_nodes.add(id(node.value))
        if node.value is not None: self.visit(node.value)
        if node.annotation is not None: self.visit(node.annotation)
        self.prepare_assignment(target_names)
        if isinstance(node.target, ast.Name) and conditional_sources:
            self.unknown.add('conditional-expression')
            for source in conditional_sources: self.add_possible_alias(node.target.id, source)
        elif isinstance(node.target, ast.Name) and isinstance(node.value, ast.Name):
            if self.control_depth > 0: self.add_possible_alias(node.target.id, alias_source)
            else: self.aliases[node.target.id] = alias_source
        elif isinstance(node.target, ast.Name) and isinstance(node.value, (ast.Attribute, ast.Subscript)):
            if member_source: self.add_possible_alias(node.target.id, member_source, member_access, member)
        elif constructor:
            self.type_bindings.append({'target': node.target.id, 'typeName': node.value.func.id, 'argumentNames': sorted(constructor_arguments)})
        elif isinstance(node.target, ast.Name) and isinstance(node.value, (ast.Dict, ast.List, ast.Tuple)):
            self.builtin_containers.add(node.target.id)
        self.visit(node.target)

    def visit_NamedExpr(self, node):
        if self.local_scopes: self.unknown.add('comprehension-scope')
        target_names = self.assigned_names(node.target)
        if isinstance(node.value, ast.Call): self.call_result_names[id(node.value)] = target_names
        alias_source = self.aliases.get(node.value.id, node.value.id) if isinstance(node.value, ast.Name) else None
        member_source = self.visible_root_name(node.value) if isinstance(node.value, (ast.Attribute, ast.Subscript)) else None
        member_access = 'subscript' if isinstance(node.value, ast.Subscript) else 'attribute'
        member = member_name(node.value) if member_source else None
        conditional_sources = {self.visible_root_name(value) for value in [node.value.body, node.value.orelse]} if isinstance(node.value, ast.IfExp) else set()
        conditional_sources.discard(None)
        constructor = isinstance(node.target, ast.Name) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id not in SAFE_CALLS | DYNAMIC_CALLS | EXTERNAL_READ_CALLS | SCOPED_MUTATION_CALLS and node.value.func.id not in self.imported_functions
        constructor_arguments = set()
        if constructor:
            constructor_arguments = {self.visible_root_name(value) for value in list(node.value.args) + [keyword.value for keyword in node.value.keywords]}
            constructor_arguments.discard(None)
            self.constructor_nodes.add(id(node.value))
        self.visit(node.value)
        self.prepare_assignment(target_names)
        if isinstance(node.target, ast.Name) and conditional_sources:
            self.unknown.add('conditional-expression')
            for source in conditional_sources: self.add_possible_alias(node.target.id, source)
        elif isinstance(node.target, ast.Name) and isinstance(node.value, ast.Name):
            if self.control_depth > 0: self.add_possible_alias(node.target.id, alias_source)
            else: self.aliases[node.target.id] = alias_source
        elif isinstance(node.target, ast.Name) and isinstance(node.value, (ast.Attribute, ast.Subscript)):
            if member_source: self.add_possible_alias(node.target.id, member_source, member_access, member)
        elif constructor:
            self.type_bindings.append({'target': node.target.id, 'typeName': node.value.func.id, 'argumentNames': sorted(constructor_arguments)})
        elif isinstance(node.target, ast.Name) and isinstance(node.value, (ast.Dict, ast.List, ast.Tuple)):
            self.builtin_containers.add(node.target.id)
        self.visit(node.target)

    visit_If = visit_control

    def visit_For(self, node):
        deterministic = static_nonempty_iterable(node.iter)
        scoped = id(node) in self.scoped_loops
        if not simple_loop_target(node.target) or not effect_only_loop_body(node.body) or not (deterministic or scoped):
            self.visit_control(node)
            return
        self.visit(node.iter)
        target_names = self.assigned_names(node.target)
        if deterministic:
            self.prepare_assignment(target_names)
            self.defined.update(target_names)
        source = self.visible_root_name(node.iter)
        self.local_scopes.append({name: source for name in target_names})
        for statement in node.body: self.visit(statement)
        self.local_scopes.pop()
        for statement in node.orelse: self.visit(statement)

    visit_AsyncFor = visit_control
    visit_While = visit_control
    visit_Try = visit_control
    visit_Match = visit_control

    def visit_IfExp(self, node):
        self.control_depth += 1
        self.generic_visit(node)
        self.control_depth -= 1

    def visit_FunctionDef(self, node):
        self.prepare_assignment([node.name])
        self.defined.add(node.name)
        self.unknown.add('function-scope')
        for value in list(node.decorator_list) + list(node.args.defaults) + [v for v in node.args.kw_defaults if v is not None]: self.visit(value)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.prepare_assignment([node.name])
        self.defined.add(node.name)
        summary = summarize_class(node)
        if summary: self.type_summaries.append(summary)
        else: self.unknown.add('class-scope')
        for value in list(node.decorator_list) + list(node.bases) + list(node.keywords): self.visit(value)

    def visit_Lambda(self, node): self.unknown.add('lambda-scope')

    def visit_comprehension(self, node, values):
        scope = {}
        self.local_scopes.append(scope)
        for generator in node.generators:
            self.visit(generator.iter)
            source = self.visible_root_name(generator.iter)
            for name in self.assigned_names(generator.target): scope[name] = source
            for condition in generator.ifs: self.visit(condition)
        for value in values: self.visit(value)
        self.local_scopes.pop()

    def visit_ListComp(self, node): self.visit_comprehension(node, [node.elt])
    def visit_SetComp(self, node): self.visit_comprehension(node, [node.elt])
    def visit_DictComp(self, node): self.visit_comprehension(node, [node.key, node.value])
    def visit_GeneratorExp(self, node): self.visit_comprehension(node, [node.elt])

    def visit_AugAssign(self, node):
        name = self.visible_root_name(node.target)
        if name:
            self.add_used(name)
            patched_member = dynamic_member_write(node.target)
            if patched_member is None or not patched_member[1]: self.mutated.add(name)
            if patched_member is not None:
                member, type_wide = patched_member
                self.member_writes.append({'receiver': name, **({'member': member} if member is not None else {}), **({'scope': 'type'} if type_wide else {})})
            if name in self.builtin_module_names: self.unknown.add('dynamic-namespace')
        else:
            self.unknown.add('dynamic-assignment')
            self.visit(node.target)
        self.visit(node.value)

    def visit_Subscript(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            name = self.visible_root_name(node)
            if name:
                self.add_used(name)
                patched_member = dynamic_member_write(node)
                if patched_member is None or not patched_member[1]: self.mutated.add(name)
                if patched_member is not None:
                    member, type_wide = patched_member
                    self.member_writes.append({'receiver': name, **({'member': member} if member is not None else {}), **({'scope': 'type'} if type_wide else {})})
                if name in self.builtin_module_names: self.unknown.add('dynamic-namespace')
            else:
                self.unknown.add('dynamic-assignment')
                self.visit(node.value)
            self.visit(node.slice)
            return
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            name = self.visible_root_name(node)
            if name:
                self.add_used(name)
                patched_member = dynamic_member_write(node)
                member, type_wide = patched_member
                if not type_wide: self.mutated.add(name)
                self.member_writes.append({'receiver': name, 'member': member, **({'scope': 'type'} if type_wide else {})})
                if name in self.builtin_module_names: self.unknown.add('dynamic-namespace')
            else:
                self.unknown.add('dynamic-assignment')
                self.visit(node.value)
            return
        self.generic_visit(node)

    def visit_Call(self, node):
        library_effect = self.library_call_effect(node)
        if library_effect and library_effect.get('unsafeNamespace'):
            self.unknown.update({'opaque-call', 'dynamic-namespace'})
        formula_rule = library_effect.get('formulaArgument') if library_effect else None
        if formula_rule:
            formula = next((keyword.value for keyword in node.keywords if keyword.arg == formula_rule.get('keyword')), None)
            position = formula_rule.get('positionalArgument')
            if formula is None and isinstance(position, int) and position < len(node.args): formula = node.args[position]
            formula_names = simple_formula_names(formula)
            if formula_names is None: self.unknown.add('opaque-call')
            else: self.possibly_used.update(formula_names)
        if id(node) in self.constructor_nodes:
            if isinstance(node.func, ast.Name):
                candidates = list(node.args) + [keyword.value for keyword in node.keywords]
                arguments = self.visible_roots(candidates)
                keyword_arguments = []
                for keyword in node.keywords:
                    keyword_arguments.append(self.keyword_argument_record(keyword))
                self.receiver_calls.append({'receiver': node.func.id, 'member': '__call__', 'kind': 'callable', 'argumentNames': arguments, 'receiverChain': [], 'receiverChainFirstArgumentNames': [], 'receiverChainPositionalArgumentNames': [], 'receiverChainPositionalStaticBooleans': [], 'receiverChainKeywordArguments': [], 'receiverValueNames': [], 'positionalArgumentNames': [self.expression_visible_roots(argument) for argument in node.args], 'positionalStaticBooleans': [argument.value if isinstance(argument, ast.Constant) and isinstance(argument.value, bool) else None for argument in node.args], 'resultNames': self.call_result_names.get(id(node), []), 'keywordArguments': keyword_arguments})
            self.generic_visit(node)
            return
        if isinstance(node.func, ast.Name) and node.func.id in DYNAMIC_CALLS:
            self.unknown.add('dynamic-namespace')
        elif isinstance(node.func, ast.Name) and node.func.id in SAFE_CALLS:
            self.safe_call_names.add(node.func.id)
            candidates = list(node.args) + [keyword.value for keyword in node.keywords]
            possible = {self.visible_root_name(candidate) for candidate in candidates}
            possible.discard(None)
            self.safe_call_argument_names.update(possible)
        elif isinstance(node.func, ast.Name) and node.func.id in EXTERNAL_READ_CALLS:
            self.safe_call_names.add(node.func.id)
            candidates = list(node.args) + [keyword.value for keyword in node.keywords]
            possible = {self.visible_root_name(candidate) for candidate in candidates}
            possible.discard(None)
            self.safe_call_argument_names.update(possible)
            self.unknown.add('external-state')
        elif isinstance(node.func, ast.Name) and node.func.id in SCOPED_MUTATION_CALLS:
            self.safe_call_names.add(node.func.id)
            candidates = list(node.args) + [keyword.value for keyword in node.keywords]
            possible = {self.visible_root_name(candidate) for candidate in candidates}
            possible.discard(None)
            self.safe_call_argument_names.update(possible)
            self.possibly_mutated.update(possible)
            if possible: self.unknown.add('opaque-mutation')
        elif isinstance(node.func, ast.Name) and node.func.id in self.imported_functions:
            candidates = list(node.args) + [keyword.value for keyword in node.keywords]
            arguments = self.visible_roots(candidates)
            keyword_arguments = []
            for keyword in node.keywords:
                keyword_arguments.append(self.keyword_argument_record(keyword))
            self.receiver_calls.append({'receiver': self.imported_functions[node.func.id], 'member': '__call__', 'kind': 'callable', 'argumentNames': arguments, 'receiverChain': [], 'receiverChainFirstArgumentNames': [], 'receiverChainPositionalArgumentNames': [], 'receiverChainPositionalStaticBooleans': [], 'receiverChainKeywordArguments': [], 'receiverValueNames': [], 'positionalArgumentNames': [self.expression_visible_roots(argument) for argument in node.args], 'positionalStaticBooleans': [argument.value if isinstance(argument, ast.Constant) and isinstance(argument.value, bool) else None for argument in node.args], 'resultNames': self.call_result_names.get(id(node), []), 'keywordArguments': keyword_arguments})
        elif isinstance(node.func, ast.Name) and node.func.id not in SAFE_CALLS:
            candidates = list(node.args) + [keyword.value for keyword in node.keywords]
            arguments = self.visible_roots(candidates)
            keyword_arguments = []
            for keyword in node.keywords:
                keyword_arguments.append(self.keyword_argument_record(keyword))
            self.receiver_calls.append({'receiver': node.func.id, 'member': '__call__', 'kind': 'callable', 'argumentNames': arguments, 'receiverChain': [], 'receiverChainFirstArgumentNames': [], 'receiverChainPositionalArgumentNames': [], 'receiverChainPositionalStaticBooleans': [], 'receiverChainKeywordArguments': [], 'receiverValueNames': [], 'positionalArgumentNames': [self.expression_visible_roots(argument) for argument in node.args], 'positionalStaticBooleans': [argument.value if isinstance(argument, ast.Constant) and isinstance(argument.value, bool) else None for argument in node.args], 'resultNames': self.call_result_names.get(id(node), []), 'keywordArguments': keyword_arguments})
        if isinstance(node.func, ast.Attribute):
            name = self.receiver_root_name(node.func.value)
            literal_receiver = isinstance(node.func.value, ast.Constant) and node.func.attr in SAFE_LITERAL_METHODS
            local_receiver = self.has_local_root(node.func.value)
            inplace = any(keyword.arg == 'inplace' and isinstance(keyword.value, ast.Constant) and keyword.value.value is True for keyword in node.keywords)
            possible_inplace = any(keyword.arg == 'inplace' and not (isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, bool)) for keyword in node.keywords)
            if name:
                arguments = self.visible_roots(list(node.args) + [keyword.value for keyword in node.keywords])
                if local_receiver:
                    self.possibly_mutated.add(name)
                    self.unknown.add('opaque-mutation')
                else:
                    result_names = self.call_result_names.get(id(node), [])
                    keyword_arguments = []
                    for keyword in node.keywords:
                        keyword_arguments.append(self.keyword_argument_record(keyword, True))
                    chain_arguments = self.receiver_chain_arguments(node.func.value)
                    self.receiver_calls.append({'receiver': name, 'member': node.func.attr, **({'kind': 'mutating'} if node.func.attr in MUTATING_METHODS or inplace else {}), 'argumentNames': arguments, 'receiverChain': self.receiver_call_chain(node.func.value), 'receiverChainFirstArgumentNames': self.receiver_chain_first_arguments(node.func.value), 'receiverChainPositionalArgumentNames': [step['positionalArgumentNames'] for step in chain_arguments], 'receiverChainPositionalStaticBooleans': [step['positionalStaticBooleans'] for step in chain_arguments], 'receiverChainKeywordArguments': [step['keywordArguments'] for step in chain_arguments], 'receiverValueNames': self.receiver_value_roots(node.func.value), 'positionalArgumentNames': [self.expression_visible_roots(argument) for argument in node.args], 'positionalStaticBooleans': [argument.value if isinstance(argument, ast.Constant) and isinstance(argument.value, bool) else None for argument in node.args], 'resultNames': result_names, 'keywordArguments': keyword_arguments})
                    effect = self.library_call_effect(node)
                    if effect and effect.get('mutatesKeyword'):
                        for keyword in node.keywords:
                            if keyword.arg == effect['mutatesKeyword']:
                                output = self.visible_root_name(keyword.value)
                                if not output: continue
                                if self.has_local_root(keyword.value):
                                    self.possibly_mutated.add(output)
                                    self.unknown.add('opaque-mutation')
                                else: self.mutated.add(output)
                if possible_inplace:
                    self.possibly_mutated.add(name)
                    self.unknown.add('opaque-mutation')
            elif not literal_receiver:
                candidates = list(node.args) + [keyword.value for keyword in node.keywords]
                possible = {self.visible_root_name(candidate) for candidate in candidates}
                possible.discard(None)
                if possible:
                    self.possibly_mutated.update(possible)
                    self.unknown.add('opaque-mutation')
                self.unknown.add('opaque-call')
            if name in self.builtin_module_names: self.unknown.add('dynamic-namespace')
        elif not isinstance(node.func, ast.Name):
            candidates = list(node.args) + [keyword.value for keyword in node.keywords]
            possible = {self.visible_root_name(candidate) for candidate in candidates}
            possible.discard(None)
            if possible:
                self.possibly_mutated.update(possible)
                self.unknown.add('opaque-mutation')
            self.unknown.add('opaque-call')
        if isinstance(node.func, ast.Name) and node.func.id in {'setattr', 'delattr'} and node.args:
            receiver = self.visible_root_name(node.args[0])
            if receiver:
                member = node.args[1].value if len(node.args) > 1 and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str) else None
                type_wide = isinstance(node.args[0], ast.Attribute) and node.args[0].attr == '__class__'
                self.member_writes.append({'receiver': receiver, **({'member': member} if member else {}), **({'scope': 'type'} if type_wide else {})})
            if receiver in self.builtin_module_names: self.unknown.add('dynamic-namespace')
        self.generic_visit(node)

def analyze(source):
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {"state": "unknown", "reasons": ["parse-error"]}
    analyzer = Analyzer(scoped_effect_loops(tree))
    analyzer.visit(tree)
    if analyzer.unknown:
        return {"state": "unknown", "reasons": sorted(analyzer.unknown), "definedNames": sorted(analyzer.defined), "usedNames": sorted(analyzer.used), "priorUsedNames": sorted(analyzer.prior_used), "possiblyUsedNames": sorted(analyzer.possibly_used), "mutatedNames": sorted(analyzer.mutated), "possiblyMutatedNames": sorted(analyzer.possibly_mutated), "aliases": [{"target": target, "source": source, "kind": "reference"} for target, source in analyzer.aliases.items()] + [{"target": target, "source": source, "kind": "possible-reference", **({"access": access} if access else {}), **({"member": member} if member else {})} for target, source, access, member in sorted(analyzer.possible_aliases)], "builtinContainerNames": sorted(analyzer.builtin_containers), "safeCallNames": sorted(analyzer.safe_call_names), "safeCallArgumentNames": sorted(analyzer.safe_call_argument_names), "typeSummaries": analyzer.type_summaries, "typeBindings": analyzer.type_bindings, "receiverCalls": analyzer.receiver_calls, "memberWrites": analyzer.member_writes}
    return {"state": "available", "definedNames": sorted(analyzer.defined), "usedNames": sorted(analyzer.used), "priorUsedNames": sorted(analyzer.prior_used), "possiblyUsedNames": sorted(analyzer.possibly_used), "mutatedNames": sorted(analyzer.mutated), "possiblyMutatedNames": sorted(analyzer.possibly_mutated), "aliases": [{"target": target, "source": source, "kind": "reference"} for target, source in analyzer.aliases.items()] + [{"target": target, "source": source, "kind": "possible-reference", **({"access": access} if access else {}), **({"member": member} if member else {})} for target, source, access, member in sorted(analyzer.possible_aliases)], "builtinContainerNames": sorted(analyzer.builtin_containers), "safeCallNames": sorted(analyzer.safe_call_names), "safeCallArgumentNames": sorted(analyzer.safe_call_argument_names), "typeSummaries": analyzer.type_summaries, "typeBindings": analyzer.type_bindings, "receiverCalls": analyzer.receiver_calls, "memberWrites": analyzer.member_writes}

print(json.dumps([analyze(source) for source in NOTEBOOK_SOURCES]))
`

export { PYTHON_ANALYZER }
