export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  ext?: string;
  children?: TreeNode[];
}

export interface RepoInfo {
  name: string;
  root: string;
}
