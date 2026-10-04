const express = require('express');
const app = express();
const path = require('path');
const PORT = 4500;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/',(req,res) =>{
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT}에서 실행 중 입니다.`);
});
