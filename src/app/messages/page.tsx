import { MessageIcon } from '@/components/icons';

export default function MessagesPage() {
  // Mock data for notifications
  const notifications = [
    {
      id: 1,
      type: '点赞',
      content: '张三 点赞了你的生活记录 "冰箱里剩下的牛肉和豌豆怎么处理？"',
      time: '2小时前'
    },
    {
      id: 2,
      type: '评论',
      content: '李四 评论了你的内容 "一个人住以后，我不再囤纸巾"',
      time: '昨天'
    },
    {
      id: 3,
      type: '回复',
      content: '王五 回复了你的评论 "这个收纳方法真的很实用"',
      time: '2天前'
    }
  ];

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 bg-gray-50 pb-16">
        <div className="max-w-md mx-auto px-4 pt-12">
          <div className="flex items-center justify-center mb-8">
            <MessageIcon className="h-6 w-6 mr-2 text-gray-600" />
            <h1 className="text-2xl font-bold">消息</h1>
          </div>
          
          <p className="text-gray-600 text-center mb-8">互动通知中心</p>
          
          <div className="space-y-4">
            {notifications.map((notification) => (
              <div key={notification.id} className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-md mb-2">
                      {notification.type}
                    </span>
                    <p className="text-gray-800">{notification.content}</p>
                  </div>
                  <span className="text-sm text-gray-500 whitespace-nowrap ml-2">{notification.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}