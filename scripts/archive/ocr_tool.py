import sys
import os

try:
    from PIL import Image
except ImportError:
    print("错误: 请先安装 pillow: pip install pillow")
    sys.exit(1)

def get_image_info(image_path):
    if not os.path.exists(image_path):
        print(f"错误: 文件不存在: {image_path}")
        return
    
    try:
        with Image.open(image_path) as img:
            print(f"图片信息:")
            print(f"  格式: {img.format}")
            print(f"  模式: {img.mode}")
            print(f"  尺寸: {img.width} x {img.height}")
            print(f"  文件大小: {os.path.getsize(image_path) / 1024:.2f} KB")
            
            if hasattr(img, 'info'):
                for key, value in img.info.items():
                    if key not in ['dpi', 'exif']:
                        print(f"  {key}: {value}")
    except Exception as e:
        print(f"错误: 无法读取图片: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python ocr_tool.py <图片路径>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    get_image_info(image_path)
