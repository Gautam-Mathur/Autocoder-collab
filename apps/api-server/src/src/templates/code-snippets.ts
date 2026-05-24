export interface CodeSnippet {
  id: string;
  name: string;
  category: string;
  description: string;
  framework: string;
  language: string;
  keywords: string[];
  code: string;
  dependencies: string[];
}

export const codeSnippets: CodeSnippet[] = [];
