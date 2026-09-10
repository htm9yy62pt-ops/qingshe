export default function StatsPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          <h1 className="text-2xl font-bold mb-8 text-center">统计</h1>
          
          {/* Impact Section */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-4 text-gray-900">Impact</h2>
            <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-200">
              <div className="text-center">
                <div className="text-3xl font-bold text-blue-600 mb-1">24</div>
                <div className="text-gray-600">本周解决问题</div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div className="text-center">
                  <div className="text-lg font-semibold text-green-600">¥180</div>
                  <div className="text-xs text-gray-500">节省金额</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-orange-600">12%</div>
                  <div className="text-xs text-gray-500">减少浪费</div>
                </div>
              </div>
            </div>
          </div>
          
          {/* Reports Section */}
          <div className="space-y-4">
            <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
              <h3 className="font-medium text-gray-900 mb-1">周报</h3>
              <p className="text-gray-500 text-sm">本周生活优化总结</p>
            </div>
            <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
              <h3 className="font-medium text-gray-900 mb-1">月报</h3>
              <p className="text-gray-500 text-sm">本月生活趋势分析</p>
            </div>
            <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
              <h3 className="font-medium text-gray-900 mb-1">年报</h3>
              <p className="text-gray-500 text-sm">年度生活优化报告</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}