import { defineConfig } from 'vite';

const [repositoryOwner, repositoryName] = (process.env.GITHUB_REPOSITORY || '').split('/');
const isAccountSite = repositoryName?.toLowerCase() === `${repositoryOwner?.toLowerCase()}.github.io`;
const base = process.env.GITHUB_ACTIONS === 'true' && repositoryName && !isAccountSite
  ? `/${repositoryName}/`
  : '/';

export default defineConfig({ base });
