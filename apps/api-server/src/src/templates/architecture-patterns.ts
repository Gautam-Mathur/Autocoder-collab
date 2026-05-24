export interface ArchitecturePattern {
  id: string;
  name: string;
  description: string;
  complexity: string;
  keywords: string[];
  suitableFor: string[];
  components?: string[];
  pros: string[];
  cons: string[];
}

export const architecturePatterns: ArchitecturePattern[] = [];
