import type { Plugin, Rule, UserConfig } from '@commitlint/types';

const CO_AUTHOR = /^co-authored-by:/im;

const noCoAuthor: Rule = (parsed) => {
  const raw = typeof parsed['raw'] === 'string' ? parsed['raw'] : '';
  return [!CO_AUTHOR.test(raw), 'Co-authored-by trailers are not allowed in this repository'];
};

const localRules: Plugin = { rules: { 'no-co-author': noCoAuthor } };

export const scopes = [
  'cli',
  'config',
  'source',
  'domain',
  'naming',
  'transform',
  'plan',
  'apply',
  'promote',
  'state',
  'verify',
  'report',
  'platform',
  'deps',
  'release',
] as const;

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  plugins: [localRules],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'build', 'ci', 'chore', 'revert'],
    ],
    'scope-enum': [2, 'always', [...scopes]],
    'scope-empty': [2, 'never'],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 72],
    'body-max-line-length': [2, 'always', 100],
    'trailer-exists': [2, 'never', 'Co-authored-by:'],
    'no-co-author': [2, 'always'],
  },
};

export default config;
