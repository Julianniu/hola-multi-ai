// 评测 S21 用：一个要跑两分半钟的统计脚本（模拟装依赖、编译、跑大表这类慢活），最后打印结果
let n = 0;
const t = setInterval(() => console.log(`处理中…已完成 ${++n * 20}%`), 30000);
setTimeout(() => {
  clearInterval(t);
  let sum = 0;
  for (let i = 2; i < 100000; i++) { let p = true; for (let j = 2; j * j <= i; j++) if (i % j === 0) { p = false; break; } if (p) sum += i; }
  console.log('统计结果：' + sum);
}, 150000);
