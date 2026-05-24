export interface TestPattern {
  id: string;
  name: string;
  category: string;
  description: string;
  testType: string;
  keywords: string[];
  template: string;
  codeTemplate: string;
  assertions: string[];
}

export const testPatterns: TestPattern[] = [];
