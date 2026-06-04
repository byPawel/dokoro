import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { getCurrentWorkspace } from '../utils/workspace.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOKORO_PATH } from '../types/devlog.js';
import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';

// Assets directory
const ASSETS_DIR = path.join(DOKORO_PATH, 'assets');
const IMAGES_DIR = path.join(ASSETS_DIR, 'images');

export const assetTools: ToolDefinition[] = [
  {
    name: 'dokoro_save_image',
    title: 'Save Image',
    description: 'Save an image to the devlog assets folder. Supports copying from a path or saving base64 data.',
    inputSchema: {
      source: z.string().describe('Source image path (absolute or relative to cwd) or base64 data'),
      name: z.string().optional().describe('Custom filename (auto-generated if not provided)'),
      subfolder: z.string().optional().describe('Subfolder within images/ (e.g., "screenshots", "diagrams")'),
      description: z.string().optional().describe('Description of the image for logging'),
    },
    handler: async ({ source, name, subfolder, description }): Promise<CallToolResult> => {
      try {
        // Determine target directory
        const targetDir = subfolder
          ? path.join(IMAGES_DIR, subfolder)
          : IMAGES_DIR;

        await fs.mkdir(targetDir, { recursive: true });

        let targetPath: string;
        let savedFrom: string;

        // Check if source is base64 data
        if (source.startsWith('data:image/') || source.match(/^[A-Za-z0-9+/]+=*$/)) {
          // Base64 data
          let base64Data = source;
          let ext = 'png';

          if (source.startsWith('data:image/')) {
            // Extract mime type and data
            const matches = source.match(/^data:image\/(\w+);base64,(.+)$/);
            if (matches) {
              ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
              base64Data = matches[2];
            }
          }

          const filename = name || `image-${Date.now()}.${ext}`;
          targetPath = path.join(targetDir, filename);

          const buffer = Buffer.from(base64Data, 'base64');
          await fs.writeFile(targetPath, buffer);
          savedFrom = 'base64 data';
        } else {
          // File path
          const sourcePath = path.isAbsolute(source) ? source : path.join(process.cwd(), source);

          // Check if source exists
          try {
            await fs.access(sourcePath);
          } catch {
            return {
              content: [
                {
                  type: 'text',
                  text: renderOutput({
                    type: 'status-card',
                    data: {
                      title: 'Source Not Found',
                      status: 'error',
                      message: `File not found: ${sourcePath}`,
                    },
                  }),
                },
              ],
            };
          }

          const ext = path.extname(sourcePath);
          const filename = name || `image-${Date.now()}${ext}`;
          targetPath = path.join(targetDir, filename);

          await fs.copyFile(sourcePath, targetPath);
          savedFrom = sourcePath;
        }

        // Get relative path for markdown reference
        const relativePath = path.relative(DOKORO_PATH, targetPath);
        const markdownRef = `![${description || 'image'}](${relativePath})`;

        // Log to current workspace if active
        const workspace = await getCurrentWorkspace();
        if (workspace.exists && workspace.content) {
          const timestamp = new Date().toISOString().slice(11, 19);
          const logEntry = `\n${icon('note')} [${timestamp}] IMAGE SAVED: ${description || path.basename(targetPath)}\n   ${markdownRef}\n`;
          await fs.writeFile(workspace.path, workspace.content + logEntry);
        }

        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Image Saved',
                  status: 'success',
                  message: description || 'Image saved to devlog',
                  details: {
                    'Location': targetPath,
                    'Relative path': relativePath,
                    'Markdown': markdownRef,
                    'From': savedFrom,
                  },
                },
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Save Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    }
  },

  {
    name: 'dokoro_save_file',
    title: 'Save File',
    description: 'Save any file to the devlog assets folder with automatic organization.',
    inputSchema: {
      source: z.string().describe('Source file path'),
      category: z.enum(['documents', 'code', 'data', 'other']).optional().default('other')
        .describe('Category for organization'),
      name: z.string().optional().describe('Custom filename'),
      description: z.string().optional().describe('Description of the file'),
    },
    handler: async ({ source, category = 'other', name, description }): Promise<CallToolResult> => {
      try {
        const sourcePath = path.isAbsolute(source) ? source : path.join(process.cwd(), source);

        // Check if source exists
        try {
          await fs.access(sourcePath);
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: renderOutput({
                  type: 'status-card',
                  data: {
                    title: 'Source Not Found',
                    status: 'error',
                    message: `File not found: ${sourcePath}`,
                  },
                }),
              },
            ],
          };
        }

        const targetDir = path.join(ASSETS_DIR, category);
        await fs.mkdir(targetDir, { recursive: true });

        const filename = name || path.basename(sourcePath);
        const targetPath = path.join(targetDir, filename);

        await fs.copyFile(sourcePath, targetPath);

        const relativePath = path.relative(DOKORO_PATH, targetPath);

        // Log to workspace
        const workspace = await getCurrentWorkspace();
        if (workspace.exists && workspace.content) {
          const timestamp = new Date().toISOString().slice(11, 19);
          const logEntry = `\n${icon('note')} [${timestamp}] FILE SAVED: ${description || filename}\n   Path: ${relativePath}\n`;
          await fs.writeFile(workspace.path, workspace.content + logEntry);
        }

        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'File Saved',
                  status: 'success',
                  message: description || filename,
                  details: {
                    'Location': targetPath,
                    'Category': category,
                    'Relative path': relativePath,
                  },
                },
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Save Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    }
  },

  {
    name: 'dokoro_list_assets',
    title: 'List Assets',
    description: 'List all saved assets in the devlog',
    inputSchema: {
      category: z.enum(['images', 'documents', 'code', 'data', 'other', 'all']).optional().default('all'),
    },
    handler: async ({ category = 'all' }): Promise<CallToolResult> => {
      try {
        const results: { category: string; files: string[] }[] = [];

        const categories = category === 'all'
          ? ['images', 'documents', 'code', 'data', 'other']
          : [category];

        for (const cat of categories) {
          const dir = path.join(ASSETS_DIR, cat);
          try {
            const files = await fs.readdir(dir);
            if (files.length > 0) {
              results.push({ category: cat, files });
            }
          } catch {
            // Directory doesn't exist
          }
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: renderOutput({
                  type: 'status-card',
                  data: {
                    title: 'No Assets',
                    status: 'info',
                    message: 'No assets found in devlog.',
                  },
                }),
              },
            ],
          };
        }

        let output = `## ${icon('note')} Devlog Assets\n\n`;
        for (const { category: cat, files } of results) {
          output += `### ${cat.charAt(0).toUpperCase() + cat.slice(1)} (${files.length})\n`;
          files.forEach(f => {
            output += `- \`assets/${cat}/${f}\`\n`;
          });
          output += '\n';
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'List Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    }
  },
];
