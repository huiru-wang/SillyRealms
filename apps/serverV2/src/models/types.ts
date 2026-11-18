export type ModelValue = {
  name: string;
  provider_id: string;
  model_id: string;
  credential_ref: string;
};
export type CreateModelInput = ModelValue & { id?: string };
export type UpdateModelInput = Partial<ModelValue>;
export type ModelListOptions = { limit?: number; offset?: number };
export type ModelConfig = ModelValue & {
  id: string;
  created_at: number;
  updated_at: number;
};
