#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusMessage>
#include <QDBusReply>
#include <QDBusUnixFileDescriptor>
#include <QFile>
#include <QFileInfo>
#include <QImage>
#include <QJsonDocument>
#include <QTemporaryFile>
#include <QTextStream>
#include <QThread>
#include <QVariantMap>

namespace {
constexpr auto kService = "org.kde.KWin";
constexpr auto kPath = "/org/kde/KWin/ScreenShot2";
constexpr auto kInterface = "org.kde.KWin.ScreenShot2";

int fail(const QString &message, int code = 1)
{
    QTextStream err(stderr);
    err << message << Qt::endl;
    return code;
}

bool parseBool(const QString &value, bool *ok)
{
    if (value == QStringLiteral("1") || value == QStringLiteral("true")) {
        *ok = true;
        return true;
    }
    if (value == QStringLiteral("0") || value == QStringLiteral("false")) {
        *ok = true;
        return false;
    }
    *ok = false;
    return false;
}

QVariantMap parseOptions(const QStringList &args, int startIndex, QString *error)
{
    QVariantMap options;
    const QHash<QString, QString> optionNames = {
        {QStringLiteral("--include-cursor"), QStringLiteral("include-cursor")},
        {QStringLiteral("--include-decoration"), QStringLiteral("include-decoration")},
        {QStringLiteral("--include-shadow"), QStringLiteral("include-shadow")},
        {QStringLiteral("--native-resolution"), QStringLiteral("native-resolution")},
        {QStringLiteral("--hide-caller-windows"), QStringLiteral("hide-caller-windows")},
    };

    for (int index = startIndex; index < args.size(); ++index) {
        const QString argument = args.at(index);
        const qsizetype separator = argument.indexOf(QLatin1Char('='));
        if (separator <= 0) {
            *error = QStringLiteral("Invalid option: %1").arg(argument);
            return {};
        }
        const QString key = argument.left(separator);
        const QString value = argument.mid(separator + 1);
        const auto mapped = optionNames.constFind(key);
        if (mapped == optionNames.cend()) {
            *error = QStringLiteral("Unknown option: %1").arg(key);
            return {};
        }
        bool valid = false;
        const bool parsed = parseBool(value, &valid);
        if (!valid) {
            *error = QStringLiteral("Option %1 expects true/false or 1/0.").arg(key);
            return {};
        }
        options.insert(mapped.value(), parsed);
    }
    return options;
}

QDBusMessage callCapture(
    QDBusInterface &interface,
    const QString &mode,
    const QStringList &args,
    const QVariantMap &options,
    const QDBusUnixFileDescriptor &descriptor,
    QString *error)
{
    if (mode == QStringLiteral("workspace")) {
        return interface.call(QStringLiteral("CaptureWorkspace"), options, QVariant::fromValue(descriptor));
    }
    if (mode == QStringLiteral("active-screen")) {
        return interface.call(QStringLiteral("CaptureActiveScreen"), options, QVariant::fromValue(descriptor));
    }
    if (mode == QStringLiteral("active-window")) {
        return interface.call(QStringLiteral("CaptureActiveWindow"), options, QVariant::fromValue(descriptor));
    }
    if (mode == QStringLiteral("screen")) {
        return interface.call(QStringLiteral("CaptureScreen"), args.at(3), options, QVariant::fromValue(descriptor));
    }
    if (mode == QStringLiteral("window")) {
        return interface.call(QStringLiteral("CaptureWindow"), args.at(3), options, QVariant::fromValue(descriptor));
    }
    if (mode == QStringLiteral("area")) {
        bool xOk = false;
        bool yOk = false;
        bool widthOk = false;
        bool heightOk = false;
        const int x = args.at(3).toInt(&xOk);
        const int y = args.at(4).toInt(&yOk);
        const uint width = args.at(5).toUInt(&widthOk);
        const uint height = args.at(6).toUInt(&heightOk);
        if (!xOk || !yOk || !widthOk || !heightOk || width == 0 || height == 0) {
            *error = QStringLiteral("Area requires valid x y width height values with non-zero dimensions.");
            return {};
        }
        return interface.call(
            QStringLiteral("CaptureArea"),
            x,
            y,
            width,
            height,
            options,
            QVariant::fromValue(descriptor));
    }

    *error = QStringLiteral("Unknown capture mode: %1").arg(mode);
    return {};
}
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    const QStringList args = app.arguments();
    if (args.size() < 3) {
        return fail(QStringLiteral(
            "Usage: devspace-screenshot-helper <workspace|active-screen|screen|active-window|window|area> <png-output> [target] [options]"));
    }

    const QString mode = args.at(1);
    int optionStart = 3;
    if (mode == QStringLiteral("screen") || mode == QStringLiteral("window")) {
        if (args.size() < 4) return fail(QStringLiteral("Capture target is required."));
        optionStart = 4;
    } else if (mode == QStringLiteral("area")) {
        if (args.size() < 7) return fail(QStringLiteral("Area capture requires x y width height."));
        optionStart = 7;
    }

    QString error;
    const QVariantMap options = parseOptions(args, optionStart, &error);
    if (!error.isEmpty()) return fail(error);

    const QString pngPath = args.at(2);
    QTemporaryFile rawFile(QStringLiteral("%1.raw.XXXXXX").arg(pngPath));
    rawFile.setAutoRemove(true);
    if (!rawFile.open()) {
        return fail(QStringLiteral("Unable to open temporary raw output: %1").arg(rawFile.errorString()));
    }
    QDBusUnixFileDescriptor descriptor(rawFile.handle());
    if (!descriptor.isValid()) return fail(QStringLiteral("Unable to create screenshot output descriptor."));

    QDBusInterface interface(kService, kPath, kInterface, QDBusConnection::sessionBus());
    if (!interface.isValid()) {
        return fail(QStringLiteral("KWin ScreenShot2 is unavailable: %1").arg(interface.lastError().message()));
    }

    const QDBusMessage reply = callCapture(interface, mode, args, options, descriptor, &error);
    if (!error.isEmpty()) return fail(error);
    if (reply.type() == QDBusMessage::ErrorMessage) {
        return fail(QStringLiteral("KWin screenshot failed: %1").arg(reply.errorMessage()), 2);
    }
    if (reply.arguments().isEmpty()) return fail(QStringLiteral("KWin screenshot returned no metadata."));

    const QVariantMap metadata = qdbus_cast<QVariantMap>(reply.arguments().constFirst());
    if (metadata.isEmpty()) return fail(QStringLiteral("KWin screenshot returned invalid metadata."));

    bool widthOk = false;
    bool heightOk = false;
    bool strideOk = false;
    bool formatOk = false;
    const uint width = metadata.value(QStringLiteral("width")).toUInt(&widthOk);
    const uint height = metadata.value(QStringLiteral("height")).toUInt(&heightOk);
    const uint stride = metadata.value(QStringLiteral("stride")).toUInt(&strideOk);
    const int formatValue = metadata.value(QStringLiteral("format")).toInt(&formatOk);
    const quint64 expectedBytes = quint64(stride) * quint64(height);
    constexpr quint64 kMaxCaptureBytes = 512ULL * 1024ULL * 1024ULL;
    if (!widthOk || !heightOk || !strideOk || !formatOk || width == 0 || height == 0 || stride == 0
        || expectedBytes == 0 || expectedBytes > kMaxCaptureBytes) {
        return fail(QStringLiteral("KWin screenshot returned invalid image dimensions or format."));
    }

    constexpr int kWaitIterations = 250;
    for (int attempt = 0; attempt < kWaitIterations; ++attempt) {
        if (quint64(QFileInfo(rawFile.fileName()).size()) >= expectedBytes) break;
        QThread::msleep(10);
    }
    if (quint64(QFileInfo(rawFile.fileName()).size()) < expectedBytes) {
        return fail(QStringLiteral("KWin screenshot pixel stream did not finish before timeout."));
    }
    if (!rawFile.seek(0)) return fail(QStringLiteral("Unable to rewind screenshot pixel stream."));
    const QByteArray pixels = rawFile.read(qint64(expectedBytes));
    if (quint64(pixels.size()) < expectedBytes) {
        return fail(QStringLiteral("KWin screenshot pixel stream was incomplete."));
    }

    const auto format = static_cast<QImage::Format>(formatValue);
    const QImage rawImage(
        reinterpret_cast<const uchar *>(pixels.constData()),
        int(width),
        int(height),
        qsizetype(stride),
        format);
    if (rawImage.isNull()) return fail(QStringLiteral("KWin returned an unsupported QImage format."));
    const QImage image = rawImage.copy();
    if (!image.save(pngPath, "PNG")) {
        return fail(QStringLiteral("Unable to encode screenshot as PNG."));
    }
    QFile::setPermissions(pngPath, QFileDevice::ReadOwner | QFileDevice::WriteOwner);

    QTextStream out(stdout);
    out << QJsonDocument::fromVariant(metadata).toJson(QJsonDocument::Compact) << Qt::endl;
    return 0;
}
