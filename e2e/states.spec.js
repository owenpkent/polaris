import { test, expect } from './fixtures.js'
import {
  SLOW_MS,
  VIEWS,
  delayRequest,
  emptyRequest,
  expectNoHorizontalOverflow,
  failRequest,
  failureBanner,
  gotoView,
  openView,
  smallTargets,
} from './support.js'

// The states between success and failure (initiatives/ui-ux-testing.md, phase 5): every view
// slow, failed, and empty. `page.route` shapes the answer to the one request each view is about;
// the server is never changed, and nothing here writes data. The service worker leaves /api/
// alone, so the page's own fetches are what the routes see.
//
// useMirrorWarm asks for every list a moment after connecting, so a route on a path also
// answers that warm-up copy. That is harmless: the warm-up throws its answers away and swallows
// failures, and the retry checks below wait for the request that follows the click.
//
// VIEWS and the route helpers (delayRequest, failRequest, emptyRequest, gotoView) live in
// support.js, shared with the screenshots of these same states in e2e/shots.spec.js.

// A delayed handler may still be sleeping when a test ends; it must not report into the next one.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

const nextRequest = (page, request) => page.waitForRequest((req) => req.method() === 'GET' && request(new URL(req.url())))

async function openDrawer(page) {
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation' })
  await expect(drawer).toBeVisible()
  return drawer
}

test.describe('States between success and failure', { tag: ['@flow'] }, () => {
  for (const [index, view] of VIEWS.entries()) {
    const next = VIEWS[(index + 1) % VIEWS.length]

    test(`${view.label}: a slow answer shows the loading state and the top bar still works`, async ({ page }, testInfo) => {
      await delayRequest(page, view.request)
      await gotoView(page, view.id)

      const main = page.getByRole('main')
      const loading = main.getByText(view.loading, { exact: true })
      await expect(loading).toBeVisible()

      const drawer = await openDrawer(page)
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()

      await expect(view.ready(page, testInfo)).toBeVisible({ timeout: SLOW_MS + 10000 })
      await expect(loading).toHaveCount(0)
    })

    test(`${view.label}: a failed answer shows the error banner and Retry loads the data`, async ({ page }, testInfo) => {
      await failRequest(page, view.request)
      await openView(page, view.id)

      const banner = failureBanner(page)
      await expect(banner).toBeVisible()
      const retry = banner.getByRole('button', { name: 'Retry' })
      await expect(retry).toBeVisible()
      expect(await smallTargets(banner), 'controls under 44px in the error banner').toEqual([])
      await expect(page.getByRole('main').getByText(view.loading, { exact: true })).toHaveCount(0)

      // The retry must be a real request, not a re-render of the old answer.
      await page.unroute(view.request)
      const refetched = nextRequest(page, view.request)
      await retry.click()
      await refetched
      await expect(banner).toBeHidden()
      await expect(view.ready(page, testInfo)).toBeVisible()

      // A failure on one view must not blank the next one.
      const drawer = await openDrawer(page)
      const nextButton = drawer.getByRole('button', { name: new RegExp(`^${next.label}`) })
      // Secondary views sit behind More in the drawer.
      if (!(await nextButton.isVisible())) await drawer.getByRole('button', { name: 'More' }).click()
      // The next view's own request must succeed; if it does not, say what the server answered
      // rather than time out on the text it would have shown.
      const nextAnswer = page.waitForResponse((res) => res.request().method() === 'GET' && next.request(new URL(res.url())))
      await nextButton.click()
      const answer = await nextAnswer
      expect(answer.status(), `${next.label} answered ${answer.status()}: ${(await answer.text()).slice(0, 300)}`).toBe(200)
      await expect(next.ready(page, testInfo)).toBeVisible()
      await expect(failureBanner(page)).toHaveCount(0)
    })

    test(`${view.label}: an empty answer shows the empty state with a way forward`, async ({ page }) => {
      await emptyRequest(page, view.emptyRequest || view.request, view.emptyBody)
      await openView(page, view.id)

      const main = page.getByRole('main')
      await expect(main.getByText(view.loading, { exact: true })).toHaveCount(0)
      for (const text of view.emptyText) {
        await expect(main.getByText(text)).toBeVisible()
      }
      for (const name of view.emptyControls) {
        await expect(main.getByRole('button', { name, exact: true }).first()).toBeVisible()
      }
      await expect(failureBanner(page)).toHaveCount(0)
      await expectNoHorizontalOverflow(page)
    })
  }

  // Board's project list has no loading state of its own: `loading` starts false and only turns
  // on once a project is picked, so while the list is in flight the view already says there are
  // no projects. This test states the current behaviour and fails once the list gets a Loading
  // state, which is the moment to delete it.
  test('Board: while the project list is still loading it already says No projects yet (SUSPECTED BUG)', async ({ page }) => {
    const list = (url) => url.pathname === '/api/projects'
    await delayRequest(page, list)
    await gotoView(page, 'board')
    const main = page.getByRole('main')
    await expect(main.getByText('No projects yet')).toBeVisible()
    await expect(main.getByText('Loading board…', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Backlog', exact: true })).toBeVisible({ timeout: SLOW_MS + 10000 })
    await expect(main.getByText('No projects yet')).toHaveCount(0)
  })

  // When the project list itself fails, the banner's Retry calls fetchBoard, which returns at
  // once because no project was ever picked: the list is never asked for again, and the
  // "No projects yet" empty state sits under the error. Current behaviour, stated so a fix
  // (Retry reloading the list) is noticed here.
  test('Board: a failed project list shows Retry, but Retry does not ask for the list again (SUSPECTED BUG)', async ({ page }) => {
    const list = (url) => url.pathname === '/api/projects'
    let listRequests = 0
    page.on('request', (req) => {
      if (req.method() === 'GET' && list(new URL(req.url()))) listRequests += 1
    })
    await failRequest(page, list)
    await openView(page, 'board')
    const banner = failureBanner(page)
    await expect(banner).toBeVisible()
    await expect(page.getByRole('main').getByText('No projects yet')).toBeVisible()

    // openView waited for the network to go idle, so the warm-up's own list requests are in.
    await page.unroute(list)
    listRequests = 0
    await banner.getByRole('button', { name: 'Retry' }).click()
    // Nothing is expected to happen, so there is no event to wait for: give a refetch time to
    // start before reading the count.
    await page.waitForTimeout(500)
    expect(listRequests, 'GET /api/projects after Retry').toBe(0)
    // fetchBoard returns before it clears the error, so the banner stays as well.
    await expect(banner).toBeVisible()
    await expect(page.getByRole('region', { name: 'Backlog', exact: true })).toHaveCount(0)
  })
})
