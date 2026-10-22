#!/usr/bin/env python3
"""
Finds constructor parameters that Nest must resolve from `design:paramtypes` but whose type
was erased by a type-only import.

`emitDecoratorMetadata` emits the *value* binding of each parameter's type. An
`import type { X }` produces no value, so the emitted metadata says `Object` and DI cannot
resolve the provider. Nothing fails at compile time, nothing fails in unit tests (they never
build a container) — the service dies at boot with `UnknownDependenciesException`.

Parameters with an explicit `@Inject(TOKEN)` are fine and are skipped.
"""
import re
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def typed_imports(src: str) -> set[str]:
    names: set[str] = set()
    for m in re.finditer(r'import\s+type\s*\{([^}]*)\}\s*from', src):
        for part in m.group(1).split(','):
            part = part.strip()
            if part:
                names.add(part.split(' as ')[-1].strip())
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from', src, re.S):
        for part in m.group(1).split(','):
            part = part.strip()
            if part.startswith('type '):
                names.add(part[5:].strip().split(' as ')[-1].strip())
    return names


def split_params(body: str) -> list[str]:
    """Splits a constructor argument list on top-level commas."""
    out, depth, current = [], 0, ''
    for ch in body:
        if ch in '([{<':
            depth += 1
        elif ch in ')]}>':
            depth -= 1
        if ch == ',' and depth == 0:
            out.append(current)
            current = ''
        else:
            current += ch
    if current.strip():
        out.append(current)
    return out


def constructors(src: str):
    for m in re.finditer(r'constructor\s*\(', src):
        start = m.end()
        depth, i = 1, start
        while i < len(src) and depth:
            if src[i] == '(':
                depth += 1
            elif src[i] == ')':
                depth -= 1
            i += 1
        yield src[start:i - 1]


def main() -> int:
    hits = []
    for pattern in ('libs/**/*.ts', 'apps/**/*.ts'):
        for f in ROOT.glob(pattern):
            if 'generated' in str(f) or '/spec' in str(f):
                continue
            src = f.read_text()
            erased = typed_imports(src)
            if not erased:
                continue
            for body in constructors(src):
                for raw in split_params(body):
                    param = raw.strip()
                    if not param or '@Inject(' in param:
                        continue
                    # last identifier before an optional default value is the type
                    names = re.findall(r'\b([A-Z][A-Za-z0-9_]*)\b', param)
                    if names and names[-1] in erased:
                        hits.append((str(f.relative_to(ROOT)), names[-1]))

    for path, name in sorted(set(hits)):
        print(f"{path}: {name}")
    total = len(set(hits))
    print(f"\nTOTAL: {total}")
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main())