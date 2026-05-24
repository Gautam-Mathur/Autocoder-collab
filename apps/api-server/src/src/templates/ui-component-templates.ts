export interface UIComponentProp {
  name: string;
  type: string;
  required?: boolean;
}

export interface UIComponentTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  keywords: string[];
  props: UIComponentProp[];
}

export const uiComponentTemplates: UIComponentTemplate[] = [];
