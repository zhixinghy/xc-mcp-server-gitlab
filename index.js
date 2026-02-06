#!/usr/bin/env node
import fetch from 'node-fetch'

const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_BASE_URL = process.env.GITLAB_BASE_URL
const LOG_LEVEL = process.env.LOG_LEVEL || 'info' // debug, info, warn, error

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] || LOG_LEVELS.info

const logger = {
  debug: (msg) => currentLogLevel <= LOG_LEVELS.debug && console.error(`[DEBUG] ${msg}`),
  info: (msg) => currentLogLevel <= LOG_LEVELS.info && console.error(`[INFO] ${msg}`),
  warn: (msg) => currentLogLevel <= LOG_LEVELS.warn && console.error(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
}

function validateEnvironment() {
  const missing = []
  if (!GITLAB_TOKEN) missing.push('GITLAB_TOKEN')
  if (!GITLAB_BASE_URL) missing.push('GITLAB_BASE_URL')

  if (missing.length > 0) {
    logger.error(`缺少必要的环境变量: ${missing.join(', ')}`)
    logger.error('请在 MCP 配置中设置:')
    console.error(
      JSON.stringify(
        {
          env: {
            GITLAB_TOKEN: '你的GitLab访问令牌',
            GITLAB_BASE_URL: 'https://gitlab.example.com'
          }
        },
        null,
        2
      )
    )
    process.exit(1)
  }

  try {
    const url = new URL(GITLAB_BASE_URL)
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('URL 必须使用 http 或 https 协议')
    }
  } catch (err) {
    logger.error(`GITLAB_BASE_URL 格式不正确: ${err.message}`)
    logger.error('示例: https://gitlab.com 或 https://gitlab.example.com')
    process.exit(1)
  }

  logger.info('环境变量验证通过')
  logger.debug(`GITLAB_BASE_URL: ${GITLAB_BASE_URL}`)
}

validateEnvironment()

const MCP_PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = {
  name: 'mcp-server-gitlab',
  version: '0.0.1'
}

const TOOL_SCHEMAS = {
  create_merge_request: {
    name: 'create_merge_request',
    description: '创建 GitLab Merge Request',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '项目 ID' },
        source_branch: { type: 'string', description: '源分支' },
        target_branch: { type: 'string', description: '目标分支' },
        title: { type: 'string', description: 'MR 标题' },
        description: { type: 'string', description: 'MR 描述' }
      },
      required: ['project_id', 'source_branch', 'target_branch', 'title']
    }
  }
}

const ResponseBuilder = {
  success(id, result) {
    return { jsonrpc: '2.0', id, result }
  },

  error(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } }
  },

  initializeResponse(id) {
    return this.success(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    })
  },

  toolsListResponse(id) {
    return this.success(id, {
      tools: Object.values(TOOL_SCHEMAS)
    })
  },

  mrSuccessResponse(id, data) {
    return this.success(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              id: data.id,
              iid: data.iid,
              web_url: data.web_url,
              source_branch: data.source_branch,
              target_branch: data.target_branch,
              state: data.state
            },
            null,
            2
          )
        }
      ]
    })
  }
}

const Validators = {
  // 验证分支名称格式
  branchName(branch) {
    if (!branch || typeof branch !== 'string') return false
    if (branch.length > 255) return false

    // GitLab 分支名规则: 不能包含特殊字符和模式
    const invalidPatterns = [
      /\s/, // 空格
      /\.\./, // 连续的点
      /^[.]/, // 以点开头
      /[.]$/, // 以点结尾
      /[~^:?*[\\\]]/, // 特殊字符
      /@\{/, // @{
      /\/\//, // 连续的斜杠
      /\.lock$/ // 以.lock结尾
    ]

    return !invalidPatterns.some((pattern) => pattern.test(branch))
  },

  // 验证项目ID格式(可以是数字或 namespace/project 格式)
  projectId(projectId) {
    if (!projectId || typeof projectId !== 'string') return false

    // 纯数字ID
    if (/^\d+$/.test(projectId)) return true

    // namespace/project 格式
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(projectId)) return true

    return false
  },

  // 验证标题
  title(title) {
    return title && typeof title === 'string' && title.trim().length > 0
  }
}

async function createMergeRequest({ project_id, source_branch, target_branch, title, description }) {
  logger.debug(`创建 MR: ${title} (${source_branch} -> ${target_branch})`)

  try {
    const url = `${GITLAB_BASE_URL}/api/v4/projects/${encodeURIComponent(project_id)}/merge_requests`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': GITLAB_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ source_branch, target_branch, title, description })
    })

    const contentType = res.headers.get('content-type')
    const isJson = contentType?.includes('application/json')
    const data = isJson ? await res.json() : { message: await res.text() }

    if (!res.ok) {
      const errorMsg = data.message || data.error || '未知错误'
      const errorDescription = data.error_description || ''
      const details = errorDescription ? `: ${errorDescription}` : ''

      logger.error(`GitLab API 错误 [${res.status}]: ${errorMsg}${details}`)
      throw new Error(`[${res.status}] ${errorMsg}${details}`)
    }

    logger.info(`MR 创建成功: ${data.web_url}`)
    return data
  } catch (err) {
    if (err.message.startsWith('[')) {
      throw err
    }

    logger.error(`网络请求失败: ${err.message}`)
    throw new Error(`网络请求失败: ${err.message}`)
  }
}

const RequestHandlers = {
  async initialize(msg) {
    return ResponseBuilder.initializeResponse(msg.id)
  },

  async 'notifications/initialized'() {
    return null // 忽略通知
  },

  async 'tools/list'(msg) {
    return ResponseBuilder.toolsListResponse(msg.id)
  },

  async 'tools/call'(msg) {
    if (msg.params?.name === 'create_merge_request') {
      return await this.handleCreateMR(msg, msg.params.arguments)
    }
    return ResponseBuilder.error(msg.id, -32601, '错误:未知工具')
  },

  async create_merge_request(msg) {
    return await this.handleCreateMR(msg, msg.params)
  },

  async handleCreateMR(msg, params) {
    const { project_id, source_branch, target_branch, title, description } = params

    if (!project_id || !source_branch || !target_branch || !title) {
      return ResponseBuilder.error(
        msg.id,
        -32602,
        '错误:缺少必要字段(project_id, source_branch, target_branch, title)'
      )
    }

    if (!Validators.projectId(project_id)) {
      logger.warn(`无效的项目ID: ${project_id}`)
      return ResponseBuilder.error(msg.id, -32602, '错误:项目ID格式不正确(应为数字或 namespace/project 格式)')
    }

    if (!Validators.branchName(source_branch)) {
      logger.warn(`无效的源分支名: ${source_branch}`)
      return ResponseBuilder.error(msg.id, -32602, `错误:源分支名称格式不正确(${source_branch})`)
    }

    if (!Validators.branchName(target_branch)) {
      logger.warn(`无效的目标分支名: ${target_branch}`)
      return ResponseBuilder.error(msg.id, -32602, `错误:目标分支名称格式不正确(${target_branch})`)
    }

    if (!Validators.title(title)) {
      logger.warn('MR 标题为空或格式不正确')
      return ResponseBuilder.error(msg.id, -32602, '错误:MR 标题不能为空')
    }

    try {
      logger.info(`处理创建 MR 请求: ${title}`)
      const data = await createMergeRequest({ project_id, source_branch, target_branch, title, description })
      return ResponseBuilder.mrSuccessResponse(msg.id, data)
    } catch (err) {
      return ResponseBuilder.error(msg.id, -32603, `GitLab API 错误:${err.message}`)
    }
  }
}

async function routeMessage(msg) {
  const handler = RequestHandlers[msg.method]
  if (handler) {
    return await handler.call(RequestHandlers, msg)
  }
  return ResponseBuilder.error(msg.id, -32601, '错误:未知方法')
}

function startServer() {
  process.stdin.setEncoding('utf8')
  logger.info('MCP 服务已启动,准备接收请求...')

  let buffer = ''

  process.stdin.on('data', async (chunk) => {
    buffer += chunk

    let lineEnd
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd)
      buffer = buffer.slice(lineEnd + 1)

      if (!line.trim()) continue

      try {
        const msg = JSON.parse(line)
        logger.debug(`收到请求: ${msg.method}`)
        const response = await routeMessage(msg)

        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n')
          logger.debug(`响应已发送: ${msg.method}`)
        }
      } catch (err) {
        logger.error(`解析或执行错误: ${err.message}`)
        const errorResponse = ResponseBuilder.error(null, -32700, `解析或执行错误:${err.message}`)
        process.stdout.write(JSON.stringify(errorResponse) + '\n')
      }
    }
  })

  process.stdin.on('end', () => {
    logger.info('MCP 服务已停止')
  })

  process.on('uncaughtException', (err) => {
    logger.error(`未捕获的异常: ${err.message}`)
    logger.debug(err.stack)
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`未处理的 Promise 拒绝: ${reason}`)
  })
}

startServer()
