export interface DomainProfile {
  id: string;
  name: string;
  industry: string;
  description: string;
  keywords: string[];
  workflows: Array<{ name: string; steps: string[]; triggers?: string[] }>;
  businessRules: string[];
  terminology: Record<string, string>;
}

export const domainProfiles: DomainProfile[] = [];
