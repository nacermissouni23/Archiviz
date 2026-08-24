import {
  FileCode2,
  FileCode,
  FileJson2,
  FileText,
  FileTerminal,
  Braces,
  FileType2,
  File as FileIcon,
} from 'lucide-react';
import type { TreeNode } from '../types';

export default function FileIconFor({ node }: { node: TreeNode }) {
  const ext = node.ext ?? '';
  const cls = 'tree-icon';
  switch (ext) {
    case '.ts':
      return <span className={`${cls} file-ts`}><FileCode2 size={14} strokeWidth={1.8} /></span>;
    case '.tsx':
      return <span className={`${cls} file-tsx`}><FileCode size={14} strokeWidth={1.8} /></span>;
    case '.js':
    case '.mjs':
    case '.cjs':
      return <span className={`${cls} file-js`}><Braces size={14} strokeWidth={1.8} /></span>;
    case '.jsx':
      return <span className={`${cls} file-jsx`}><FileCode size={14} strokeWidth={1.8} /></span>;
    case '.py':
      return <span className={`${cls} file-py`}><FileTerminal size={14} strokeWidth={1.8} /></span>;
    case '.json':
      return <span className={`${cls} file-json`}><FileJson2 size={14} strokeWidth={1.8} /></span>;
    case '.md':
      return <span className={`${cls} file-md`}><FileText size={14} strokeWidth={1.8} /></span>;
    case '.css':
      return <span className={`${cls} file-css`}><FileType2 size={14} strokeWidth={1.8} /></span>;
    default:
      return <span className={cls}><FileIcon size={14} strokeWidth={1.8} /></span>;
  }
}
