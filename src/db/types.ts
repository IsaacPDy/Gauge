import type { tables } from "./schema";

export type { Json } from "./json";
export type TableName = keyof typeof tables;
/** A row as selected from the table, in the same shape PostgREST rows had. */
export type Row<K extends TableName> = (typeof tables)[K]["$inferSelect"];
/** A row as inserted into the table. */
export type NewRow<K extends TableName> = (typeof tables)[K]["$inferInsert"];
