export default function ProfilePage() {
  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          <h1 className="text-2xl font-bold mb-6">我的</h1>
          
          <div className="space-y-4">
            <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
              <h2 className="font-medium text-gray-900">账号</h2>
            </div>
            <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
              <h2 className="font-medium text-gray-900">设置</h2>
            </div>
            <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
              <h2 className="font-medium text-gray-900">反馈</h2>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}