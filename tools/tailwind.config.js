// index.html 안의 tailwind.config 와 같은 색 설정 (CDN 대신 빌드해서 쓰기 위함)
module.exports = {
  content: ['../index.html'],
  theme: { extend: { colors: { finvizDark: '#000000', finvizCard: '#0b0e13', finvizBorder: '#1c222b', accentCyan: '#06b6d4', bullGreen: '#10b981', bearRed: '#ef4444', foolGold: '#f59e0b', slate: { 700: '#232a34', 800: '#151a21', 900: '#0a0d12', 950: '#000000' } } } }
};
