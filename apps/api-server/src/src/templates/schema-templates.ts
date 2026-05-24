export interface SchemaColumn {
  name: string;
  type: string;
  constraints?: string[];
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  indexes?: string[];
  foreignKeys?: Array<{ column: string; references: string }>;
}

export interface SchemaTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  keywords: string[];
  useCases: string[];
  tables: SchemaTable[];
}

export const schemaTemplates: SchemaTemplate[] = [];
