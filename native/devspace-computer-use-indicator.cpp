#include <algorithm>

#include <QApplication>
#include <QColor>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusReply>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLinearGradient>
#include <QPainter>
#include <QScreen>
#include <QTimer>
#include <QWidget>
#include <LayerShellQt/Window>

#include <cmath>
#include <memory>
#include <vector>

namespace {
constexpr int kThickness = 18;
constexpr auto kTitlePrefix = "DevSpace Computer Use Indicator";
constexpr auto kKWinPluginName = "devspace-computer-use-indicator-capture-exclusion";

enum class Edge { Top, Bottom, Left, Right };

QColor stateColor(const QString &state) {
    if (state == QStringLiteral("controlling")) return QColor(QStringLiteral("#58B9FF"));
    if (state == QStringLiteral("waiting")) return QColor(QStringLiteral("#F2C66D"));
    if (state == QStringLiteral("user")) return QColor(QStringLiteral("#55D69B"));
    if (state == QStringLiteral("error")) return QColor(QStringLiteral("#FF657C"));
    return QColor(QStringLiteral("#9A7BFF"));
}

class GlowEdge final : public QWidget {
public:
    GlowEdge(QScreen *screen, Edge edge, QWidget *parent = nullptr)
        : QWidget(parent), m_edge(edge) {
        setWindowTitle(QStringLiteral("%1 · %2 · %3")
                           .arg(QString::fromLatin1(kTitlePrefix), edgeName(), screen->name()));
        setAttribute(Qt::WA_TranslucentBackground, true);
        setAttribute(Qt::WA_TransparentForMouseEvents, true);
        setWindowFlag(Qt::FramelessWindowHint, true);
        setWindowFlag(Qt::Tool, true);
        setWindowFlag(Qt::WindowStaysOnTopHint, true);
        setWindowFlag(Qt::WindowDoesNotAcceptFocus, true);
        setWindowFlag(Qt::WindowTransparentForInput, true);
        setWindowFlag(Qt::NoDropShadowWindowHint, true);
        create();
        auto *handle = windowHandle();
        handle->setScreen(screen);
        auto *layer = LayerShellQt::Window::get(handle);
        layer->setScreen(screen);
        layer->setLayer(LayerShellQt::Window::LayerOverlay);
        // Use the physical output bounds, not Plasma's reserved work area.
        // In layer-shell, an exclusive zone of -1 tells KWin to ignore
        // panel/dock exclusive zones when positioning this overlay surface.
        layer->setExclusiveZone(-1);
        layer->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityNone);
        layer->setActivateOnShow(false);
        layer->setScope(QStringLiteral("devspace-computer-use-indicator"));
        using W = LayerShellQt::Window;
        switch (edge) {
        case Edge::Top:
            layer->setAnchors(W::Anchors(W::AnchorTop) | W::AnchorLeft | W::AnchorRight);
            layer->setDesiredSize(QSize(0, kThickness));
            break;
        case Edge::Bottom:
            layer->setAnchors(W::Anchors(W::AnchorBottom) | W::AnchorLeft | W::AnchorRight);
            layer->setDesiredSize(QSize(0, kThickness));
            break;
        case Edge::Left:
            layer->setAnchors(W::Anchors(W::AnchorTop) | W::AnchorBottom | W::AnchorLeft);
            layer->setDesiredSize(QSize(kThickness, 0));
            break;
        case Edge::Right:
            layer->setAnchors(W::Anchors(W::AnchorTop) | W::AnchorBottom | W::AnchorRight);
            layer->setDesiredSize(QSize(kThickness, 0));
            break;
        }
    }

    void setGlow(const QColor &color, qreal opacity) {
        m_color = color;
        m_opacity = opacity;
        update();
    }

protected:
    void paintEvent(QPaintEvent *) override {
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing, false);
        QColor strong = m_color;
        strong.setAlphaF(std::clamp(m_opacity, 0.0, 1.0));
        QColor soft = m_color;
        soft.setAlpha(0);
        QLinearGradient gradient;
        switch (m_edge) {
        case Edge::Top:
            gradient = QLinearGradient(0, 0, 0, height());
            gradient.setColorAt(0.0, strong);
            gradient.setColorAt(0.32, QColor(strong.red(), strong.green(), strong.blue(), qRound(strong.alpha() * 0.55)));
            gradient.setColorAt(1.0, soft);
            break;
        case Edge::Bottom:
            gradient = QLinearGradient(0, height(), 0, 0);
            gradient.setColorAt(0.0, strong);
            gradient.setColorAt(0.32, QColor(strong.red(), strong.green(), strong.blue(), qRound(strong.alpha() * 0.55)));
            gradient.setColorAt(1.0, soft);
            break;
        case Edge::Left:
            gradient = QLinearGradient(0, 0, width(), 0);
            gradient.setColorAt(0.0, strong);
            gradient.setColorAt(0.32, QColor(strong.red(), strong.green(), strong.blue(), qRound(strong.alpha() * 0.55)));
            gradient.setColorAt(1.0, soft);
            break;
        case Edge::Right:
            gradient = QLinearGradient(width(), 0, 0, 0);
            gradient.setColorAt(0.0, strong);
            gradient.setColorAt(0.32, QColor(strong.red(), strong.green(), strong.blue(), qRound(strong.alpha() * 0.55)));
            gradient.setColorAt(1.0, soft);
            break;
        }
        painter.fillRect(rect(), gradient);
    }

private:
    QString edgeName() const {
        switch (m_edge) {
        case Edge::Top: return QStringLiteral("top");
        case Edge::Bottom: return QStringLiteral("bottom");
        case Edge::Left: return QStringLiteral("left");
        case Edge::Right: return QStringLiteral("right");
        }
        return QStringLiteral("edge");
    }

    Edge m_edge;
    QColor m_color = QColor(QStringLiteral("#9A7BFF"));
    qreal m_opacity = 0.75;
};

bool installCaptureExclusion(const QString &scriptPath) {
    if (!QFileInfo::exists(scriptPath)) return false;
    QDBusInterface scripting(
        QStringLiteral("org.kde.KWin"),
        QStringLiteral("/Scripting"),
        QStringLiteral("org.kde.kwin.Scripting"),
        QDBusConnection::sessionBus());
    if (!scripting.isValid()) return false;
    scripting.call(QStringLiteral("unloadScript"), QString::fromLatin1(kKWinPluginName));
    QDBusReply<int> loaded = scripting.call(
        QStringLiteral("loadScript"), scriptPath, QString::fromLatin1(kKWinPluginName));
    if (!loaded.isValid() || loaded.value() < 0) return false;
    QDBusReply<void> started = scripting.call(QStringLiteral("start"));
    return started.isValid();
}

class IndicatorController final : public QObject {
public:
    IndicatorController(QString statePath, QObject *parent = nullptr)
        : QObject(parent), m_statePath(std::move(statePath)) {
        rebuildWindows();
        connect(qApp, &QGuiApplication::screenAdded, this, [this](QScreen *) { rebuildWindows(); });
        connect(qApp, &QGuiApplication::screenRemoved, this, [this](QScreen *) { rebuildWindows(); });
        m_poll.setInterval(120);
        connect(&m_poll, &QTimer::timeout, this, [this]() { refreshState(); });
        m_poll.start();
        m_animation.setInterval(33);
        connect(&m_animation, &QTimer::timeout, this, [this]() { animate(); });
        m_animation.start();
        refreshState();
    }

private:
    void rebuildWindows() {
        m_windows.clear();
        for (auto *screen : QGuiApplication::screens()) {
            for (Edge edge : {Edge::Top, Edge::Bottom, Edge::Left, Edge::Right}) {
                auto window = std::make_unique<GlowEdge>(screen, edge);
                window->hide();
                m_windows.push_back(std::move(window));
            }
        }
    }

    void refreshState() {
        QFile file(m_statePath);
        if (!file.open(QIODevice::ReadOnly)) {
            applyState(QStringLiteral("idle"));
            return;
        }
        const auto document = QJsonDocument::fromJson(file.readAll());
        if (!document.isObject()) {
            applyState(QStringLiteral("idle"));
            return;
        }
        applyState(document.object().value(QStringLiteral("state")).toString(QStringLiteral("idle")));
    }

    void applyState(const QString &state) {
        if (m_state == state) return;
        m_state = state;
        const bool visible = state != QStringLiteral("idle");
        m_color = stateColor(state);
        for (auto &window : m_windows) {
            if (visible) window->show();
            else window->hide();
        }
        animate();
    }

    void animate() {
        if (m_state == QStringLiteral("idle")) return;
        m_phase += 0.11;
        qreal opacity = 0.76;
        if (m_state == QStringLiteral("controlling")) {
            opacity = 0.68 + 0.20 * (0.5 + 0.5 * std::sin(m_phase));
        } else if (m_state == QStringLiteral("waiting")) {
            opacity = 0.62 + 0.10 * (0.5 + 0.5 * std::sin(m_phase * 0.55));
        } else if (m_state == QStringLiteral("error")) {
            opacity = 0.68 + 0.22 * (0.5 + 0.5 * std::sin(m_phase * 1.35));
        } else if (m_state == QStringLiteral("user")) {
            opacity = 0.72;
        }
        for (auto &window : m_windows) window->setGlow(m_color, opacity);
    }

    QString m_statePath;
    QString m_state = QStringLiteral("__initial__");
    QColor m_color = QColor(QStringLiteral("#9A7BFF"));
    qreal m_phase = 0.0;
    QTimer m_poll;
    QTimer m_animation;
    std::vector<std::unique_ptr<GlowEdge>> m_windows;
};
} // namespace

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("DevSpace Computer Use Indicator"));
    QGuiApplication::setDesktopFileName(QStringLiteral("org.shiryustudios.DevSpace.ComputerUseIndicator"));
    if (argc != 2) return 2;

    const QString statePath = QString::fromLocal8Bit(argv[1]);
    const QString scriptPath = QCoreApplication::applicationDirPath()
        + QStringLiteral("/../share/devspace-computer-use-indicator-kwin.js");
    if (!installCaptureExclusion(QFileInfo(scriptPath).canonicalFilePath().isEmpty()
            ? scriptPath
            : QFileInfo(scriptPath).canonicalFilePath())) {
        // Fail closed: an indicator that cannot be excluded from compositor capture is not shown.
        return 3;
    }

    IndicatorController controller(statePath);
    return app.exec();
}
