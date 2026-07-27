import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MediaViewer from '../components/MediaViewer.jsx';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalImage = global.Image;

describe('MediaViewer', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:media-viewer');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    global.Image = originalImage;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens an SVG in a full-screen viewer and supports view transforms', async () => {
    const user = userEvent.setup();
    render(
      <MediaViewer svg='<svg aria-label="diagram"></svg>' alt='线程状态图'>
        <span>图表缩略图</span>
      </MediaViewer>
    );

    await user.click(screen.getByRole('button', { name: '全屏查看：线程状态图' }));

    expect(screen.getByRole('dialog', { name: '线程状态图 全屏预览' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByLabelText('当前缩放 125%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '向右旋转' }));
    expect(document.querySelector('.media-viewer-canvas').style.transform).toContain('rotate(90deg)');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('edits Mermaid source, previews the result, and downloads the edited SVG', async () => {
    const user = userEvent.setup();
    const renderSource = vi.fn().mockResolvedValue('<svg viewBox="0 0 200 100" aria-label="edited diagram"></svg>');

    render(
      <MediaViewer
        svg='<svg viewBox="0 0 100 200" aria-label="original diagram"></svg>'
        alt='状态图'
        filename='线程状态图'
        editableSource={'stateDiagram-v2\nA --> B'}
        renderSource={renderSource}
      >
        <span>状态图</span>
      </MediaViewer>
    );

    await user.click(screen.getByRole('button', { name: '全屏查看：状态图' }));
    await user.click(screen.getByRole('button', { name: '编辑图表源码' }));
    const editor = screen.getByRole('textbox', { name: 'Mermaid 源代码' });
    await user.clear(editor);
    await user.type(editor, 'stateDiagram-v2{enter}A --> C');
    await user.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => expect(renderSource).toHaveBeenCalledWith('stateDiagram-v2\nA --> C'));
    expect(await screen.findByLabelText('edited diagram')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '向右旋转' }));
    await user.click(screen.getByRole('button', { name: '保存图片' }));
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const downloadedSvg = URL.createObjectURL.mock.calls[0][0];
    expect(await downloadedSvg.text()).toContain('rotate(90)');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });

  it('exports rotation edits for raster images through a canvas', async () => {
    const user = userEvent.setup();
    const context = {
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob(['edited'], { type: 'image/png' }));
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['original'], { type: 'image/png' })),
    }));
    global.Image = class MockImage {
      naturalWidth = 120;
      naturalHeight = 80;

      set src(_value) {
        queueMicrotask(() => this.onload?.());
      }
    };

    render(
      <MediaViewer src='/images/thread.png' alt='线程配图' filename='线程配图'>
        <img src='/images/thread.png' alt='线程配图' />
      </MediaViewer>
    );

    await user.click(screen.getByRole('button', { name: '全屏查看：线程配图' }));
    await user.click(screen.getByRole('button', { name: '向右旋转' }));
    await user.click(screen.getByRole('button', { name: '保存图片' }));

    await waitFor(() => expect(context.drawImage).toHaveBeenCalled());
    expect(context.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });
});
