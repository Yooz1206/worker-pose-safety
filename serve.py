"""本地静态服务器（带正确的 .wasm MIME 类型）

浏览器调用 MediaPipe 的 WASM 运行时时要求 .wasm 以 application/wasm 返回，
部分 Python 安装未内置该映射，会导致模型加载失败。这里显式补上。
"""
import http.server
import os
import socketserver

PORT = 8123

http.server.SimpleHTTPRequestHandler.extensions_map.update({
    '.wasm': 'application/wasm',
    '.task': 'application/octet-stream',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
})

os.chdir(os.path.dirname(os.path.abspath(__file__)))
socketserver.TCPServer.allow_reuse_address = True

if __name__ == '__main__':
    print(f'作业人员姿态识别与安全追踪系统')
    print(f'请用浏览器访问: http://localhost:{PORT}/')
    print('按 Ctrl+C 停止服务')
    with socketserver.TCPServer(('127.0.0.1', PORT), http.server.SimpleHTTPRequestHandler) as srv:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print('\n服务已停止')
