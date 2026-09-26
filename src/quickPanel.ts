import * as vscode from 'vscode';
import { artistLine, fullTitle } from './api';
import { Player, fmtTime } from './player';

type Item = vscode.QuickPickItem & { run?: () => Thenable<unknown> | Promise<unknown>; keepOpen?: boolean };

/**
 * Мини-плеер, всплывающий по клику на трек в статус-баре:
 * управление, быстрый выбор источника и переход по очереди.
 */
export function showQuickPanel(player: Player): void {
  const qp = vscode.window.createQuickPick<Item>();
  qp.matchOnDescription = true;
  qp.placeholder = 'Управление и очередь — начните вводить, чтобы найти трек в очереди';
  const cmd = (id: string, ...args: unknown[]) => () => vscode.commands.executeCommand(id, ...args);

  const build = () => {
    const s = player.snapshot();
    const t = s.current;
    qp.title = t
      ? `${s.status.playing ? '▶' : '⏸'} ${artistLine(t)} — ${fullTitle(t)}  ·  ${fmtTime(s.status.position)} / ${fmtTime(s.status.duration)}`
      : 'Яндекс Музыка';

    const items: Item[] = [];
    if (t) {
      items.push(
        { label: 'Управление', kind: vscode.QuickPickItemKind.Separator },
        { label: s.status.playing ? '$(debug-pause) Пауза' : '$(play) Играть', run: cmd('yandexMusic.playPause'), keepOpen: true },
        { label: '$(chevron-right) Следующий трек', run: cmd('yandexMusic.next'), keepOpen: true },
        { label: '$(chevron-left) Предыдущий трек', run: cmd('yandexMusic.previous'), keepOpen: true },
        { label: s.liked ? '$(heart-filled) Убрать из «Мне нравится»' : '$(heart) Нравится', run: cmd('yandexMusic.like'), keepOpen: true },
      );
    }
    items.push({ label: 'Включить', kind: vscode.QuickPickItemKind.Separator });
    if (!s.account) {
      items.push({ label: '$(account) Войти в аккаунт Яндекса', run: cmd('yandexMusic.signIn') });
    }
    items.push(
      { label: '$(pulse) Моя волна', description: 'персональный поток', run: cmd('yandexMusic.playMyWave'), keepOpen: true },
      { label: '$(heart-filled) Мне нравится', run: cmd('yandexMusic.playLiked'), keepOpen: true },
      { label: '$(list-unordered) Плейлист…', run: cmd('yandexMusic.playPlaylist') },
      { label: '$(search) Поиск трека…', run: cmd('yandexMusic.search') },
      { label: '$(layout-sidebar-left) Открыть панель плеера', run: cmd('yandexMusic.player.focus') },
    );
    if (s.queue.length) {
      items.push({ label: `Очередь · ${s.source}`, kind: vscode.QuickPickItemKind.Separator });
      s.queue.forEach((q, i) => {
        items.push({
          label: `${i === s.index ? '$(play-circle)' : '$(blank)'} ${fullTitle(q)}`,
          description: artistLine(q),
          detail: undefined,
          run: () => player.playIndex(i),
          keepOpen: true,
        });
      });
    }
    const active = qp.activeItems[0]?.label;
    qp.items = items;
    const again = items.find((i) => i.label === active || (active?.includes('Пауза') && i.label.includes('Играть')) || (active?.includes('Играть') && i.label.includes('Пауза')));
    if (again) {
      qp.activeItems = [again];
    }
  };

  build();
  const sub = player.onDidChange(() => {
    // не перестраиваем список, пока пользователь фильтрует его
    if (!qp.value) {
      build();
    }
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item?.run) {
      return;
    }
    if (!item.keepOpen) {
      qp.hide();
    }
    try {
      await item.run();
    } catch (e) {
      player.showError(e);
    }
    if (item.keepOpen) {
      qp.value = '';
      build();
    }
  });
  qp.onDidHide(() => {
    sub.dispose();
    qp.dispose();
  });
  qp.show();
}
