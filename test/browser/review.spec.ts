import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDemo } from '../../scripts/demo.ts';
import { startServer } from '../../web/server.ts';
let root: string, app: Awaited<ReturnType<typeof startServer>>;
test.beforeEach(async () => { root=mkdtempSync(join(tmpdir(),'codeboost-browser-'));app=await startServer(createDemo(join(root,'demo')),0); });
test.afterEach(async () => { await app.close();rmSync(root,{recursive:true,force:true}); });
test('reviews real changes, persists approval and conversation, and assigns foreign code',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
  await expect(page.getByText('0 of 3 approved')).toBeVisible();await expect(page.getByText('– No tests defined',{exact:false}).first()).toBeVisible();
  await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  await page.getByRole('button',{name:'Request change',exact:true}).click();await page.getByLabel('Change to request').fill('Add a test for the upper bound.');await page.getByRole('button',{name:'Save change request'}).click();await expect(page.getByText('Add a test for the upper bound.',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('1 of 3 approved')).toBeVisible();await expect(page.getByText('Add a test for the upper bound.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Unplanned changes/}).click();await page.getByLabel('Assign change 1 to').selectOption('P1');await page.getByRole('button',{name:'Assign',exact:true}).first().click();
  await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();await expect(page.getByText('! Stale:',{exact:false})).toBeVisible();await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
  await page.screenshot({path:'test-results/review-desktop.png',fullPage:true});expect(errors).toEqual([]);
});
test('shows file metadata and no-change confirmation, supports narrow desktop and keyboard',async({page})=>{
  await page.goto(app.url);await page.getByRole('button',{name:/P2 Document retry behavior/}).click();await expect(page.getByText('File mode changed',{exact:false})).toBeVisible();await expect(page.getByText('✕ Out of scope',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/P3 Confirm API compatibility/}).click();await page.getByRole('button',{name:'Confirm no change needed',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  await page.setViewportSize({width:1280,height:900});await expect(page.getByRole('complementary',{name:'Conversation',exact:true})).not.toBeVisible();await page.getByRole('button',{name:'Conversation',exact:true}).click();await expect(page.getByRole('complementary',{name:'Conversation',exact:true})).toBeVisible();
  await page.getByLabel('Question about this item').fill('npa');await expect(page.getByRole('heading',{name:'Confirm API compatibility'})).toBeVisible();
  await page.keyboard.press('Escape');await page.keyboard.press('p');await expect(page.getByRole('heading',{name:'Document retry behavior'})).toBeVisible();
  await page.setViewportSize({width:1000,height:800});await expect(page.getByRole('heading',{name:'A little more room to review'})).toBeVisible();
});
test('refresh makes changed code stale and stale browser actions cannot approve it',async({page,context})=>{
  await page.goto(app.url);await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  const other=await context.newPage();await other.goto(app.url);await expect(other.getByText('1 of 3 approved')).toBeVisible();
  const repository=app.service.config.repository;writeFileSync(join(repository,'retry.ts'),'export function delay(attempt: number) {\n  return 42;\n}\n');execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-am','External change'],{cwd:repository,stdio:'pipe'});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByText('! Stale:',{exact:false}).first()).toBeVisible();
  await other.getByRole('button',{name:/P3 Confirm API compatibility/}).click();await other.getByRole('button',{name:'Confirm no change needed',exact:true}).click();await expect(other.getByRole('status').filter({hasText:'Stale review state'})).toBeVisible();
});
test('requires private credentials and rejects foreign origins',async({request})=>{
  const base=app.url.split('#')[0]!;
  expect((await request.get(base+'api/review')).status()).toBe(403);
  expect((await request.get(base+'api/review',{headers:{'x-codeboost-token':app.token,origin:'https://example.invalid'}})).status()).toBe(403);
  expect((await request.get(base+'api/review',{headers:{'x-codeboost-token':app.token}})).status()).toBe(200);
});
test('shows an honest history error and keeps markup in notes as text',async({page})=>{
 await page.goto(app.url);await page.getByLabel('Question about this item').fill('<img src=x onerror=alert(1)>');await page.getByRole('button',{name:'Save question'}).click();await expect(page.getByText('<img src=x onerror=alert(1)>',{exact:true})).toBeVisible();await expect(page.locator('#notes img')).toHaveCount(0);
 const repository=app.service.config.repository;execFileSync('git',['checkout','--orphan','unrelated'],{cwd:repository,stdio:'pipe'});execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Unrelated history'],{cwd:repository,stdio:'pipe'});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByText('Could not read this branch’s history.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Approve P1',exact:true})).not.toBeVisible();
});
