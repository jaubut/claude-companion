import {
  FileEdit, Terminal, Eye, FileText, Search, FolderSearch, Globe,
} from "lucide-react"

export const TOOL_ICONS: Record<string, typeof Terminal> = {
  Edit: FileEdit,
  Write: FileText,
  Read: Eye,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
}

export function getToolSummary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Edit":
      return [
        input.file_path as string,
        input.old_string ? `\n- ${(input.old_string as string)}` : "",
        input.new_string ? `\n+ ${(input.new_string as string)}` : "",
      ].filter(Boolean).join("")
    case "Write":
      return [
        input.file_path as string,
        input.content ? `\n${(input.content as string)}` : "",
      ].filter(Boolean).join("")
    case "Read":
      return (input.file_path as string) ?? ""
    case "Bash":
      return (input.command as string) ?? ""
    case "Grep":
      return [
        `/${input.pattern as string ?? ""}/`,
        input.path ? ` in ${input.path as string}` : "",
      ].join("")
    case "Glob":
      return (input.pattern as string) ?? ""
    default:
      return JSON.stringify(input, null, 2)
  }
}
