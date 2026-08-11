import { save } from "./store";
export function createUser(name) { return save({ name }); }
