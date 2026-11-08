/** Test helper: a response body as loosely typed JSON, for asserting on the wire shape. */
// biome-ignore lint/suspicious/noExplicitAny: wire JSON asserted field by field
export type Json = any;

export const json = (res: Response): Promise<Json> => res.json();
