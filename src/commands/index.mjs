// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { apply } from './apply.mjs';
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { check } from './check.mjs';
import { diff } from './diff.mjs';
import { exec } from './exec.mjs';
import { node, refs, trace } from './inspect.mjs';
import { orgs } from './orgs.mjs';
import { pull } from './pull.mjs';
import { push } from './push.mjs';
import { rebase } from './rebase.mjs';
import { restore } from './restore.mjs';
import { spend } from './spend.mjs';
import { test } from './test.mjs';
import { log, status } from './status.mjs';
import { trial } from './trial.mjs';
import { versions } from './versions.mjs';

export const COMMANDS = { auth, orgs, bots, versions, pull, node, trace, refs, apply, diff, check, push, rebase, restore, status, log, exec, spend, trial, test };
