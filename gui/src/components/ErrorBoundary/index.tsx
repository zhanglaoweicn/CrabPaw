import { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Home, Bug } from 'lucide-react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo })
    
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    
    if (process.env.NODE_ENV === 'development') {
      console.group('🔍 Error Details')
      console.error('Error:', error.message)
      console.error('Stack:', error.stack)
      console.error('Component Stack:', errorInfo.componentStack)
      console.groupEnd()
    }
  }

  handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    })
  }

  handleGoHome = () => {
    // 单界面（贾维斯）下无 Dashboard home tab——仅重置错误态，自动回到 VoiceShell
    this.handleRetry()
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      const isNetworkError = this.state.error?.message?.includes('fetch') ||
        this.state.error?.message?.includes('network') ||
        this.state.error?.message?.includes('Network')

      const isConfigError = this.state.error?.message?.includes('config') ||
        this.state.error?.message?.includes('API Key')

      return (
        <div className="min-h-screen theme-bg-primary flex items-center justify-center p-4">
          <div className="max-w-md w-full">
            <div className="theme-card p-6 text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full theme-bg-tertiary flex items-center justify-center">
                {isNetworkError ? (
                  <AlertTriangle className="w-8 h-8 text-yellow-500" />
                ) : isConfigError ? (
                  <Bug className="w-8 h-8 text-orange-500" />
                ) : (
                  <AlertTriangle className="w-8 h-8 text-red-500" />
                )}
              </div>
              
              <h2 className="text-xl font-bold theme-text-primary mb-2">
                {isNetworkError ? '网络连接问题' : isConfigError ? '配置错误' : '出错了'}
              </h2>
              
              <p className="theme-text-secondary mb-4">
                {isNetworkError
                  ? '无法连接到服务器，请检查网络连接后重试。'
                  : isConfigError
                  ? '应用配置出现问题，请检查设置。'
                  : '应用遇到了一个意外错误，请尝试刷新页面。'}
              </p>
              
              {process.env.NODE_ENV === 'development' && this.state.error && (
                <div className="mb-4 p-3 rounded theme-bg-tertiary text-left overflow-auto max-h-40">
                  <p className="text-xs font-mono text-red-400 break-all">
                    {this.state.error.message}
                  </p>
                  {this.state.error.stack && (
                    <pre className="text-xs font-mono text-gray-500 mt-2 whitespace-pre-wrap">
                      {this.state.error.stack.split('\n').slice(0, 5).join('\n')}
                    </pre>
                  )}
                </div>
              )}
              
              <div className="flex gap-3 justify-center">
                <button
                  onClick={this.handleRetry}
                  className="theme-btn theme-btn-secondary"
                >
                  <RefreshCw className="w-4 h-4" />
                  重试
                </button>
                
                <button
                  onClick={this.handleGoHome}
                  className="theme-btn theme-btn-primary"
                >
                  <Home className="w-4 h-4" />
                  返回首页
                </button>
              </div>
              
              <button
                onClick={this.handleReload}
                className="mt-3 text-sm theme-text-muted hover:theme-text-primary transition-colors"
              >
                刷新页面
              </button>
            </div>
            
            <div className="mt-4 text-center text-sm theme-text-muted">
              如果问题持续存在，请联系技术支持
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  fallback?: ReactNode
) {
  return function WithErrorBoundaryWrapper(props: P) {
    return (
      <ErrorBoundary fallback={fallback}>
        <WrappedComponent {...props} />
      </ErrorBoundary>
    )
  }
}
