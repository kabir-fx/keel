/**
 * @keel/protocol: the board contract.
 *
 * Events, items, the model and picture specs (schemas and types), the reducer, the rules,
 * the digest, and what travels on the wire. Every other package depends on this one, and
 * only the orchestrator changes it.
 */
export const PROTOCOL_VERSION = 1;

export * from './ids';
export * from './model';
export * from './pictures';
export * from './items';
export * from './events';
export * from './state';
export * from './reduce';
export * from './rules';
export * from './digest';
export * from './log';
export * from './wire';
export * from './link';
export * from './fixture';
export * from './brief';
export * from './secrets';
