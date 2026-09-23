// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { orgs } from './orgs.mjs';

export const COMMANDS = { auth, orgs, bots };
