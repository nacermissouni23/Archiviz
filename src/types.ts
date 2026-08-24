export interface TreeNode {
  name: string;
  path: string; // posix-style relative path, '' for root
  type: 'dir' | 'file';
  ext?: string;
  children?: TreeNode[];
}
