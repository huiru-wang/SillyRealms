export type ModelConfig={
  id:string;name:string;providerId:string;modelId:string;
  credentialStatus:'configured'|'missing'|'unavailable';
  createdAt:number;updatedAt:number;
};
