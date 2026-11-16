# Design red flags

Screen every candidate before choosing. A red flag is a reason to revise or reject the shape.

Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.

## Shallow module

A large interface that hides little. Callers coordinate several methods to finish one operation, options expose internal stages, and learning the interface does not save anyone from learning the implementation. Apply the deletion test: imagine the module gone. If the complexity vanishes, it was a pass-through. If it reappears in every caller, the module earns its place.

A deep module is not a deep call chain. A deep call chain scatters understanding across layers.

## Information leakage

Two or more modules depend on the same internal decision, so changing it means coordinated edits. Re-exporting a wire type, a storage schema, or a framework object through a public interface is leakage. Parse external data into domain types behind the interface.

## Temporal decomposition

Modules named for the order things happen in (load, validate, transform, save) instead of the knowledge they own. The same representation and its rules get repeated across every step. Group code by what it knows. Steps that run at different times belong together when they protect the same decisions.

## Pass-through method

A method that forwards the same arguments to another with the same shape. It adds a layer and hides nothing. Remove it, unless it adds policy or adapts between two real abstractions.

## Split ownership

More than one module writes the same state, or keeps its own copy. An editor of one writer cannot see the others, so their rules drift. Give each piece of state one owner. Others read it or ask the owner to change it.

## Two ways to do one task

A contributor copies whichever way it finds first, so both keep gaining callers. Keep one way. Move callers off the other and delete it in the same change.

## Importable internals

If a caller can import a module's internals, the shortest path that compiles will, and the internals become interface. Make them unreachable from outside, so the wrong import fails the build.

## Hand-synced list

Two places list the same items, and adding one means editing both. Keep one list and derive the other. If it cannot be derived, make the build fail when they disagree.

## Shared mutable state between concurrent actors

"We will add a lock" is a smell to check, not an answer. First ask whether the actors need the same object at all. Give each its own file, key, or queue, and merge where the result is read. Share one writer only when that is a real invariant, and then enforce it with structure (a single owner thread, a queue), not with a convention.
