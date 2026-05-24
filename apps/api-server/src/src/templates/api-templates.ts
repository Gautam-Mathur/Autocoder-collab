export interface ApiResponseField {
  field: string;
  type: string;
}

export interface ApiTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  keywords: string[];
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathPattern: string;
  middleware: string[];
  responseSchema: ApiResponseField[];
}

export const apiTemplates: ApiTemplate[] = [];
