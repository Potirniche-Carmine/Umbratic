import { save } from "./store";
export function createUser(name: string) { return save({ name }); }
