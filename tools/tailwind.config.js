// index.html 안의 tailwind.config 와 같은 색 설정 (CDN 대신 빌드해서 쓰기 위함)
module.exports = {
  content: ['../index.html'],
  theme: { extend: { colors: { finvizDark: '#0e1726', finvizCard: '#131e32', finvizBorder: '#1e293b', accentCyan: '#06b6d4', bullGreen: '#10b981', bearRed: '#ef4444', foolGold: '#f59e0b' } } }
};
