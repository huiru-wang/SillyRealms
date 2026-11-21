import {createContext,useContext} from 'react';
import type {StoryConfiguration} from './story-types.js';
export type {MessageComponentProps,MessageComponent,MessageRule,MessageMatch,StoryConfiguration} from './story-types.js';
export const StoryContext=createContext<StoryConfiguration>({rules:[],components:{},state:{},ready:()=>{},match:async()=>({matches:[],warning:false})});
export function useStoryConfiguration(){return useContext(StoryContext);}
