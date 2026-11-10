const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'../server/firebase-auth.js');

test('Firebase verifier accepts only signed, current Google tokens for this project',async()=>{
    assert.ok(fs.existsSync(file),'server must verify Firebase tokens before trusting an account');
    const {createFirebaseVerifier}=require(file);
    const {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT}=require('jose');
    const {privateKey,publicKey}=await generateKeyPair('RS256');
    const jwk=await exportJWK(publicKey);jwk.kid='test-key';jwk.alg='RS256';
    const verify=createFirebaseVerifier({keySet:createLocalJWKSet({keys:[jwk]}),now:()=>1800000000});
    const claims={sub:'user-A',aud:'space-cycle-1b705',iss:'https://securetoken.google.com/space-cycle-1b705',iat:1799999990,exp:1800003600,auth_time:1799999900,firebase:{sign_in_provider:'google.com'}};
    const sign=payload=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(privateKey);
    assert.equal((await verify(await sign(claims))).uid,'user-A');
    for(const patch of [{aud:'other-project'},{iss:'https://evil.example'}, {exp:1799999999},{iat:1800000001},{auth_time:1800000001},{sub:''},{sub:'x'.repeat(129)},{firebase:{sign_in_provider:'anonymous'}},{exp:undefined},{iat:undefined}]){
        await assert.rejects(verify(await sign({...claims,...patch})),/invalid_token/);
    }
    const forged=(await sign(claims)).split('.');forged[1]=Buffer.from(JSON.stringify({...claims,sub:'user-B'})).toString('base64url');
    await assert.rejects(verify(forged.join('.')),/invalid_token/);
    for(const token of ['',null,'not.jwt', 'x'.repeat(20000)])await assert.rejects(verify(token),/invalid_token/);
});
