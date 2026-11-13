const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const file=path.join(__dirname,'../server/visits.js');

test('found places persist per account and UNIQUE user/place prevents duplicate increments',()=>{
    assert.ok(fs.existsSync(file),'durable unique visit store must exist');
    const {openVisits}=require(file);
    const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'space-cycle-visits-'));
    const filename=path.join(dir,'visits.sqlite');
    try {
        let store=openVisits(filename);
        assert.deepEqual(store.list('user-A'),{foundSpaces:[],foundSpaceCount:0});
        assert.equal(store.record('user-A','indoor-01').newlyFound,true);
        for(let i=0;i<5;i++)assert.equal(store.record('user-A','indoor-01').newlyFound,false);
        assert.deepEqual(store.list('user-A'),{foundSpaces:['indoor-01'],foundSpaceCount:1});
        assert.deepEqual(store.list('user-B'),{foundSpaces:[],foundSpaceCount:0});
        assert.equal(store.record('user-B','indoor-01').newlyFound,true);
        assert.throws(()=>store.record('user-A','indoor-02'),/not_configured/);
        assert.throws(()=>store.record('user-A','bogus'),/not_configured/);
        assert.throws(()=>store.record('','indoor-01'),/invalid_user/);
        store.close();store=openVisits(filename);
        assert.deepEqual(store.list('user-A'),{foundSpaces:['indoor-01'],foundSpaceCount:1});
        assert.equal(store.record('user-A','indoor-01').newlyFound,false);
        store.close();
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
